# ADR-0130 — Client observability: error overlay + event ring + F9 bug-report bundle (H1/H2/H3 taxonomy)

**Status:** Accepted
**Date:** 2026-07-19
**Slice:** pt-b1
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, tooling-docs, security-authz

**Decision:** A dismissible self-mounting overlay unifies uncaught/unhandled-rejection/reducer errors into a capped error ring; a capped event ring records the H1/H2/H3 proxy taxonomy (identity-hex only); F9 downloads a network-free JSON bug bundle.

---

## Context

The playtest-first replan (2026-07) needs **playtest observability** before the fun gate
(M-playtest-b, the M20 pull-forward). A tester who hits a bug today produces "it broke" — there is
no error surface, no trace, no state snapshot — and the gate's H1/H2/H3 fun-hypotheses have **no
measurement**. This slice (`pt-b1`, client-only) delivers the *client* half: an error surface, a
structured event ring for the H1/H2/H3 proxies, and a one-keypress bug bundle. The *server* half —
the additive `playtest_event` table + reducer hooks + reaper + `just playtest-report` — is **pt-b2**
(SERIAL/structural) and out of scope here.

`pt-a1` (ADR-0128) already exposed the build provenance (`BUILD_INFO` / ungated `window.__mrBuild`)
that the F9 bundle consumes to pin which build a finding came from across wipe/republish cycles.

Determinism constraint (ADR-0003): instrumentation must not perturb the rule core. All events are
written in the **imperative shell** (`main.ts`) or the `client/src/ui/*` sinks; `game-core`
(Rust/wasm) is untouched. Pure event constructors take an **injected clock** argument (never
`Date.now()` internally) so the ring is deterministic under test.

## Decision

### 1. Event taxonomy (pre-committed IN FULL so the gate report is not post-hoc)

A discriminated union `PlaytestEvent` keyed on `kind`. Every variant carries an envelope
`{ tSeq: number, tMs: number }` — `tSeq` is a monotonic per-session counter (deterministic
ordering); `tMs` is a shell-supplied wall-clock stamp (provenance only, **never** used for logic).
Payloads carry **only numbers, string ids, and identity-hex** — never a player name or free text.

| kind | payload (beyond envelope) | hypothesis | wired in pt-b1? |
|---|---|---|---|
| `connect` | `identity: hex` | session | **yes** |
| `disconnect` | — (link is gone) | session | **yes** |
| `zoneChange` | `fromZone, toZone: number` | session | **yes** |
| `battleStart` | `battleId: string, isPvp: boolean` | session | **yes** |
| `battleEnd` | `battleId: string, outcome: string, turnCount: number` | session | **yes** |
| `rankedMatch` | `battleId: string, ratingDelta: number` (signed Elo) | **H3** | **yes** |
| `preRecruitHp` | `battleId: string, hpPermille: number` (0..1000 int) | **H1** | parked → pt-b1b |
| `recruitAttempt` | `battleId: string, baitItemId: number` | **H1** | parked → pt-b1b |
| `recruitResult` | `battleId: string, success: boolean` | **H1** | parked → pt-b1b |
| `boxOpen` | — | **H2** | parked → pt-b1b |
| `monsterRelease` | `speciesId: number` | **H2** | parked → pt-b1b |
| `reCatch` | `speciesId: number` (already-owned species) | **H2** | parked → pt-b1b |
| `tradePropose` | `tradeId: string` | **H3** | parked → pt-b1b |
| `tradeConfirm` | `tradeId: string` | **H3** | parked → pt-b1b |

Notes:
- `hpPermille` is an **integer 0..1000** (`round(currentHp/maxHp*1000)`, clamped, div-by-zero-safe) —
  not a float — to keep the ring diffable and drift-free.
- `battleId`/`tradeId` are **strings** (`bigint.toString()`) — bigint cannot survive
  `JSON.stringify` (the same constraint the DEV trade hook already respects, main.ts:1094).
- `disconnect` carries no identity by design — the link is gone; identity is already in `connect`
  and in the bundle top-level.
- `connect` is emitted on **both** first-connect (`onReady`) **and** reconnect (`onReconnect`, using
  the retained module-scope identity) so a drop→reconnect stream is `…disconnect,connect…` rather
  than a dangling `disconnect` (reviewer M-1).
- `disconnect` is emitted **only** from the `onError` callback when `where === 'link'` (the genuine
  connected→disconnected edge, `connection.ts:147` `wasConnected` guard). The single `onError`
  callback also receives `where ∈ {connect, subscribe, join}` on retry/subscription failures — those
  must **not** emit `disconnect` (else the ring floods with bogus drops during backoff). The emit is
  therefore at the callback with a `where === 'link'` string-equality guard, **never** inside
  `reportError` (which all wheres reach). A redundant `disconnect` on the bfcache `pageshow` path
  (`connection.ts:175`) is acceptable — it is a genuine drop (red-team B-1, reviewer H-3).

### 2. Right-size: CORE now, PARK the expensive sources (pt-b1b)

The FULL taxonomy (14 variants) is committed here so the gate report is pre-committed. `pt-b1`
**wires the 6 store-delta / lifecycle variants** (connect, disconnect, zoneChange,
battleStart, battleEnd, rankedMatch). connect/disconnect/zoneChange are single-callback events.
battleStart/battleEnd/rankedMatch are **edge-detected** and therefore carry their own module-scope
latches — `lastBattleId` (emit `battleStart` when `latest.battleId` changes; guard the
stale-terminal-at-first-sight case like `decideBattleOverlay`), `lastBattleOutcome` (emit `battleEnd`
on the first Ongoing→terminal transition for a battleId), and `lastOwnRating` (emit `rankedMatch` on
a rating change). **rankedMatch runs in its OWN unconditional `store.onBatchApplied` listener** — NOT
the visibility-gated leaderboard listener (main.ts:986), which early-returns while the board is
closed and would silently miss nearly every match (reviewer B-1, red-team H-1). All three latches
are seeded first-sight (no emit on initial hydration) and **reset in `resetPredictionState()` /
`onReconnect`** so they re-baseline with `store.reset()` rather than straddling it (a stale latch vs.
a freshly re-hydrated store would double-count). Every emit site early-returns on `identity === ''`
(cold-start content batches precede the own player row). The 8 **handler-wired / correlation-heavy**
variants (preRecruitHp,
recruitAttempt, recruitResult, boxOpen, monsterRelease, reCatch, tradePropose, tradeConfirm) are
**defined-but-unemitted**, parked to **pt-b1b**, which only adds `eventRing.push(makeEvent…())` call
sites + their delta-tracking + constructor tests. The ring API, the overlay, and the F9 bundle are
unchanged by pt-b1b (the bundle serializes "whatever is in the ring") — a clean YAGNI seam. Smaller
focused PRs review better.

### 3. Error surface unified on the M13.5 seam

`reportError(text)` (main.ts:166) is the existing reducer-rejection sink (routes `sendGuarded`
rejections, sets `#status` textContent + `console.error`). It is **augmented** to also push a
normalized record into the **error ring** and notify the overlay — the existing `#status` behavior
is preserved (e2e depend on it). Additionally the shell registers `window` `'error'` and
`'unhandledrejection'` listeners feeding the same ring + overlay.

**`normalizeError` is the single ingress** — every source (window listeners, the reportError-augment
path) routes through it; it truncates the message to `ERROR_MSG_MAX_LEN`, handles `Error` / string /
`.reason`, and never throws. The length cap is **leak containment**: `reportError` receives
pre-formatted strings that today are numeric-id-only server `Err`s (`guards.rs` name errors are
static), but a future `Err(format!("… {name} …"))` or a thrown `Error` carrying a stack/URL is one
edit from putting free text into the ring and then the F9 bundle. The cap bounds that blast radius;
the no-PII teeth (T-BUNDLE-3) assert the **error** ring, not just the event ring, is name-free under a
canary (red-team B-2). The window handlers are **re-entrancy-guarded** (a scoped try/catch that
swallows to `console` only + an already-handling latch) so a throw *inside* error handling — e.g. a
throwing overlay render — cannot recurse into the same listener or starve the client (the window path
has none of `store.flushBatch`'s per-listener isolation, store.ts:568). The overlay render is total
(red-team M-2).

### 4. Self-mounting, non-blocking overlay

`index.html` and `vite.config.ts` are out of this slice's touch-set, so the overlay **self-mounts**
its DOM (creates + appends its own root, exactly like the `#status` div at main.ts:1486) rather than
reading a pre-existing element. Its root uses a **new unique id** (not `status`, not any existing
index.html id) and a `pointer-events:none` non-interactive backdrop so it cannot intercept gameplay
clicks/focus. It is **non-blocking**: it is NOT in the movement-suppression overlay list
(main.ts:728-741); it never `preventDefault`s gameplay movement keys and never focus-traps. The
dismiss branch sits **before** the `KEY_DIR` lookup in the keydown ladder and, only when the overlay
is visible, hides it + `preventDefault` + `return` (no fall-through to `step()`); when the overlay is
hidden it is a no-op that does NOT `preventDefault` (so the key still does its normal thing). A
movement key pressed while the overlay is visible still reaches `step()` (S-1). Data is rendered via
`textContent`/`dataset`/`replaceChildren` only — never `innerHTML` (XSS; server/user text must never
become markup) (reviewer L-3, red-team M-3).

### 5. F9 bug bundle — no network dependency

F9 assembles `{ build sha, identity, zone, event-ring snapshot, error-ring snapshot, key store
snapshot }` and downloads it via `Blob` + `URL.createObjectURL` + a synthetic `<a download>` click +
`revokeObjectURL` — **no** `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` / dynamic
`import(` / reducer / `conn` call. The bundle must work when the connection itself is the bug.

- **`buildBugBundle`/`serializeBugBundle` are PURE** — they take a pre-projected snapshot object +
  the rings + `BUILD_INFO` as plain arguments, read no globals (`window`/`store`), and
  **`bugBundle.ts` imports nothing from `net/*`**. The shell does the impure reads and passes them in.
  This keeps the module 100%-coverable (no `typeof`-guard fallback branches, cf. ADR-0128 §L-1) AND
  makes the no-network invariant *structural*: a source-scan asserts `bugBundle.ts` has zero
  `from './net`/`from '../net` imports, and the F9-region scan in `main.ts` bans the network needles.
  Scanning only the main.ts region is necessary-but-not-sufficient — an indirect `fetch` in a helper
  is caught by the pure-import rule (red-team H-2).
- **`serializeBugBundle` is bigint-total** — a `JSON.stringify` replacer coerces any `bigint` to
  string, so a snapshot field sourced from a raw store id (`bigint`) never throws
  `TypeError: Do not know how to serialize a BigInt` — the failure mode that would break F9 exactly
  when the tester needs it (red-team M-1).
- **CSP/sandbox fallback** — the whole F9 body is wrapped so a blocked `createObjectURL`/anchor-click
  (sandboxed iframe, strict CSP, some webviews) does not silently no-op: on any exception it
  `console.log`s the serialized JSON and surfaces "bug bundle: download blocked — copy from console"
  through the error ring/overlay, so the tester always has a path to the bundle (red-team M-4).

### 5a. Key store snapshot — pinned non-PII scalar allowlist

The bundle's "key store snapshot" is an **enumerated allowlist of non-PII scalars**, never a
wholesale serialization of store rows (which carry player-controlled `StoreProfile.name`,
`StorePlayer.name`, `StoreMonsterPub.nickname`). The shell projects it before calling `buildBugBundle`:
`{ playerCount, ownEntityId (hex string), currentZoneId, ongoingBattleId (string|null),
ownRating/ownWins/ownLosses (numbers, NO name), ownMonsterCount, inventoryCount }`. The no-PII tooth
sets every store name/nickname field to a canary string and asserts the serialized bundle contains
**zero** occurrences of the canary — asserting on the value, not merely the absence of a `name` key
(reviewer H-2, red-team H-3).

### 6. Touch-set-driven module placement

The declared touch-set is `client/src/ui/*` + `client/src/net/store.ts` + `client/src/main.ts` (+
sibling tests + docs). The new pure modules (`eventRing`, `errorRing`, `bugBundle`,
`errorOverlayModel`, `errorOverlayView`) are therefore placed under **`client/src/ui/`** — a
deliberate placement to stay literally in-scope, not an architectural claim that a ring buffer is
"UI". `store.ts` is not modified (events are observed from `main.ts` via public accessors).

### 7. Bounded memory

Both rings are **capped, oldest-evicted** — never unbounded — with pinned small constants
`EVENT_RING_CAP = 256`, `ERROR_RING_CAP = 64` (and `ERROR_MSG_MAX_LEN = 512`) so the serialized F9
bundle stays bounded (no OOM on a low-memory device / huge data-URL). Eviction is exact: a burst that
pushes N≫cap in one turn leaves exactly the newest `cap` in FIFO order (the caps teeth assert
post-burst contents, not just `length`). `tSeq` is an ordering stamp only, never a ring slot index.
The client ring is the tester's local buffer; the server-side capped/TTL-reaped `playtest_event`
table is pt-b2.

## Consequences

- Playtesters get a real error surface + a one-keypress, offline-safe bug bundle; the gate gets its
  H1/H2/H3 proxy stream (partially in pt-b1, completed in pt-b1b).
- The overlay View is **fully unit-tested** (happy-dom), not coverage-excluded — the
  `dom-shell-coverage-exclusion` eval exact-set-guards the exclude list and this slice cannot touch
  `vite.config.ts`.
- Proof-of-teeth lives as in-tree `*.test.ts` (ring caps, no-PII, no-network F9 source-scan, XSS,
  non-blocking) — **no** new `evals/*.eval.mjs` (evals/** is out of touch-set).
- pt-b1b is reserved for the 8 parked emit-sites; pt-b2 for the server table.

## Implementation-review reconciliation (reviewer + red-team + determinism lens)

The determinism/netcode lens found **no perturbation** (new listeners are read-only + total; switchZone
atomicity preserved; F9/F8 outside the movement path; zero game-core/wasm/RNG touch). The security-critical
invariants (PII firewall, no-network, XSS, re-entrancy, bounded memory) were verified CLOSED. Fixed findings:

- **`isPvpBattle` party guard (reviewer H-1):** `opponentIdentity !== playerIdentity` alone mislabels every
  wild encounter as PvP (wild carries the all-zero `WILD_IDENTITY`). `battleStart.isPvp` now uses the pure
  `isPvpBattle(battle)` helper (`opponentMonsterIds.length > 0 && distinct identity`), mirroring
  `battleModel.ts`; covered by `T-ISPVP` (wild/self/empty-party → false).
- **rankedMatch battleId attribution (red-team M-2):** `latestPlayerBattle()` returns the highest-id battle
  of any kind; the Elo delta now attaches the battleId only when that battle `isPvpBattle`, else `''`.
- **battleStart reconnect dedup (red-team M-1):** a `battleReseedPending` flag (set on `onReconnect` only)
  re-baselines a surviving Ongoing battle on the first post-reconnect batch without re-emitting battleStart.
- **F9 serialize-in-try (red-team L-1) + single timestamp (reviewer L-1):** `serializeBugBundle` moved inside
  the try so a serialize fault also hits the console fallback; one `capturedAtMs` for body + filename.
- **Key-store no-PII tooth (red-team L-2):** `W-KEYSTORE-NOPII` source-scan asserts the F9 region (incl.
  `projectKeyStore`) reads no `.name`/`.nickname`/`.displayName`, guarding the projection allowlist.

**Accepted residuals (no change):** (a) `lastOwnRating`/`activeBattleId` also re-baseline on intra-session
zone-switch (resetPredictionState), so a ranked/battle delta landing in the same batch as a zone transition
is not emitted — an unlikely race, and re-baselining is the ADR-accepted posture (reviewer L-2). (b) The ring
`snapshot()` is an array-level defensive copy; records are `readonly`-typed plain data read-only by every
consumer, so deep-freezing is unwarranted YAGNI (reviewer L-3). (c) A `battleEnd` that resolves entirely
during a disconnect gap is not observed — the reconnect re-baseline introduces no spurious end (red-team M-1
symmetric note).

## Alternatives considered

- **Ship all 14 event sources now.** Rejected: doubles the emit-site count with correlation
  bookkeeping (recruitResult attempt↔result, reCatch owned-species diffing) that reviews better in
  its own focused PR. Taxonomy is still pre-committed so nothing is lost.
- **Replace the `#status` line with the overlay.** Rejected: existing e2e depend on `#status`;
  augment, don't replace.
- **Reuse `window.__game` snapshot for the bundle.** Rejected: `__game` is DEV-gated (ADR-0127) and
  absent in the production playtest build; the bundle must run in production, so it reads the store
  via public accessors + the ungated `BUILD_INFO`.
- **Add an `evals/*.eval.mjs` no-network gate.** Deferred: would touch `evals/**` (out of touch-set);
  the source-scan tooth in `main.wiring.test.ts` covers it in-scope.

## Amendment — 16r-f (2026-08-22): sticky reseed latch + drop-time id capture

The M-1 `battleReseedPending` flag (lines 211–212) was consumed on the FIRST post-reconnect batch even when
`latestPlayerBattle()` returned `undefined`. Since ADR-0198 the battle map is rebuilt on every flush from the
SDK view cache, so a flush firing before `my_battle` hydrates burned the latch, and the NEXT flush re-emitted
a spurious `battleStart` for the surviving battle — the F9 bundle showed a battle "starting" that never did.
That behavior leaned on ADR-0198 D7's "assumed" subscription-batch atomicity; 16r-f removes the dependency.

**16r-f refines the flag to a truly sticky latch:** `latest === undefined` leaves it armed; any definite row
resolves it.

- New module-scope `reseedPrevBattleId` captures the drop-time `activeBattleId` as `onReconnect`'s first
  statement (before `resetPredictionState` nulls it), guarded by `if (!battleReseedPending)` so a second drop
  mid-reseed preserves the first capture.
- The silent re-baseline applies **only** when the observed battle is Ongoing **and** its id equals the
  captured one. Any other definite observation falls through to the normal emit logic — a battle that STARTED
  during the gap now correctly emits `battleStart` (previously it was silently adopted as the "survivor",
  later producing an unpaired `battleEnd`).
- The listener nulls `reseedPrevBattleId` on resolution as defensive hygiene — measured inert today (the
  guarded `onReconnect` capture overwrites it before any read).

**Spec-deviation rationale:** the 16r-f spec prescribed only the sticky half ("do not clear on an undefined
read"). Implemented alone, that leaves the latch armed indefinitely for a player with zero battle rows
(common — the server GCs finished battles), silently swallowing their next NEW battle's `battleStart`. The
id-capture refinement was adopted after plan review; the EARS contract is unchanged, only the mechanism is
stronger.

**Gating tests:** `client/src/main.battle-reseed.test.ts` — the repo's first runtime-import gate over
`main.ts` (mocked wasm/connection/renderer, F9-bundle observation, per-test module reset + listener cleanup).
T1/T8 proven RED at fork; six mutation bite-proofs measured, incl. T9 (double-reconnect keeps the first
capture) and T10 (two fully-resolved reseed episodes re-capture per episode).

**Residuals** (updating the Accepted-residuals list at lines 218–224):
- (c) **unchanged** — a `battleEnd` resolving entirely during the gap is still unobserved.
- (d) **NEW** — if the `my_battle` view hydrates partially across flushes with ≥2 rows, an older row observed
  first resolves the latch and the newer surviving battle still emits spuriously. Closing it needs a
  subscription-applied signal from `connection.ts` (outside 16r-f's touch-set).
- (e) **NEW, pre-existing** — `main.ts`'s `identity` is captured once in `onReady` and never refreshed on
  reconnect; a reconnect that mints a new SDK identity would leave every identity-scoped listener (this one
  included) permanently quiet, with the reseed latch armed. Flagged for a follow-up slice.

## Amendment — 17r-b (2026-09-03): hydration-gated reseed latch + identity refresh on reconnect

16r-f's sticky latch (above) resolved on the FIRST defined `latestPlayerBattle()` read after a reconnect against a
single captured `reseedPrevBattleId`. The two residuals it disclosed — (d) and (e) — are closed here by an explicit
hydration-complete edge fired from `connection.ts` and by carrying the connection's identity in `onReconnect`.

**Contract changes (`ConnectionOptions`, connection.ts):**
- `onReconnect` is WIDENED from `() => void` to `(identity: string) => void`, called from `.onApplied` with the
  module-local identity the SDK handed `onConnect`. A rebuild can mint a NEW anon identity (`continueAnonymously()`
  after a session-expired terminal, or the nh4 token-rejection suppression path) while `hadSession` is already true,
  so a caller that keeps its `onReady`-time identity deafens every identity-gated listener. `main.ts` now reassigns
  its module-local `identity` as the FIRST statement of `onReconnect`, so the `connect` ring event and every batch
  listener see the new value. Type-carried, not type-enforced: TS parameter bivariance means a reverted zero-arg
  handler still typechecks — the fix is pinned by RSD17B-CARRIES / IDROT / ORPHAN, not by the compiler.
- NEW required `onHydrated: () => void` — the hydration-complete edge. A `snapshotApplied` flag is armed inside
  `.onApplied` (after the stale-build guard, before the notify tail) and consumed by the batcher flush closure on the
  first flush that follows: AFTER the `my_monster_pub`/`my_battle` view reconciles (the store now holds the applied
  snapshot), BEFORE `store.flushBatch()` (every listener that flush notifies observes it as already delivered), and
  OUTSIDE the `live !== undefined` guard (a parked build must not leave the flag armed for a later bogus edge). Once,
  on the first flush following each applied snapshot — guaranteed today by the always-non-empty content
  subscriptions, which schedule that flush. Required rather than optional: an unwired embedder fails at compile
  time instead of shipping a permanently-armed latch (`main.ts` is the only production constructor).

**main.ts:** a single module-local `hydratedSinceReconnect` (set by `onHydrated`; reset UNCONDITIONALLY in
`onReconnect`, while the `reseedPrevBattleId` capture keeps its 16r-f `if (!battleReseedPending)` guard) replaces the
`latest === undefined` stickiness. The reseed branch returns while un-hydrated — an empty flush OR one carrying an
older surviving row can no longer burn the latch — and otherwise resolves; a post-hydration `undefined` read is
definitive (the player has no battle rows), so the resolved branch reads `latest?.outcome`. Plan review caught that
without that null guard the COMMON no-battle reconnect would throw inside the listener, swallowed by its try/catch
behind a coincidentally-correct ring; the suite now carries a global `console.error` control for exactly that shape.

**Reachability, stated plainly.** On spacetimedb npm 2.6.0 (`db_connection_impl.ts:861-884`) `SubscribeApplied`
applies the cache, emits `applied` (where `onReconnect` runs), THEN dispatches the row callbacks, all within one
synchronous message-processing turn; the microtask flush therefore always reconciles the COMPLETE `my_battle` cache
after `onReconnect`. Residual (d)'s partial-hydration ordering is NOT reachable on 2.6.0. It ships anyway as a
delivery-model-independent contract — this ADR's own proposal — because the pending npm bump to 2.7.1+/2.8.1 (SDK
auto-reconnect; AGENTS.md) is exactly the change that could alter delivery. Residual (e) IS reachable today.

**Gating tests** (ordinary vitest per ADR-0224; no eval added): `client/src/main.battle-reseed.test.ts` re-sequences
T1..T10 with a `signalHydrated()` step where production hydrates, and adds six teeth — RSD17B-STALEROW (an older
terminal row observed pre-hydration must not resolve the latch), RSD17B-ONGOINGROW (a non-survivor Ongoing row
observed first keeps it), RSD17B-REARM (a second reconnect re-arms against its own hydration), RSD17B-NOBATTLE (a
post-hydration flush with no rows resolves without throwing), RSD17B-IDROT (a fresh identity re-targets the listener
and the connect event), RSD17B-ORPHAN (the previous identity's orphan row no longer re-baselines) — plus the global
console.error control. `connection.test.ts` adds RSD17B-SIGNAL (presence, contiguity, order relative to `flushBatch`,
exclusion from the live-guard, file-wide writer census, arm-after-stale-guard) and RSD17B-CARRIES (the
identity-carrying call site and the two interface members). `main.wiring.test.ts`'s NH5_RECONNECT_START anchor now
tracks the new handler signature (same assertions). Acceptance gate B1 runs the five specs with an exactly-once
census of the eight ids AND a 17-test floor on the reseed file — the plan red-team measured that without the floor,
deleting T3+T6 (the only pre-existing tests that prove the latch RESOLVES under an ignore-signal mutant) stayed green.
Two fixture facts are load-bearing: `latestPlayerBattle` returns the HIGHEST id and `upsertBattle` never removes
rows, so the survivor must be the higher id in every ordering fixture; and "the survivor itself observed
pre-hydration" is non-discriminating (silent re-baseline either way).

**Alternatives considered:** a pull-based `Connection.hydrationGen()` accessor (stub edits in three specs; a pull
cannot distinguish flush-before-reconcile from after); firing from `onApplied` itself (cache-complete, not
store-reconciled); resolving inside the `onHydrated` handler (duplicates the emit decision outside the single owning
listener); a two-counter generation scheme (collapsed by /simplify to the one boolean — equivalent under every
interleaving); moving `onReady`/`onReconnect` out of `onApplied` into the flush closure so that `onReconnect` itself
is the hydration signal and the sticky latch disappears (rejected: shifts 20+ consumers by a microtask and makes the
spec's EARS scenario unrepresentable — noted as a future simplification).

**Residuals** (updating the 16r-f list above):
- (c) **unchanged** — a `battleEnd` resolving entirely during the gap is still unobserved.
- (d) **CLOSED** — the latch resolves on the hydration edge, independent of subscription-batch atomicity.
- (e) **CLOSED** — `onReconnect(identity)`; `main.ts`'s identity is refreshed first and unconditionally.
- (f) **NEW** — connection.ts's FIRING of `onHydrated` is proven by source-scan only (RSD17B-SIGNAL). The runtime
  suite mocks `net/connection` and drives `onHydrated` itself, so a `return` inserted between the reconcile block
  and the signal, a third `snapshotApplied` writer in another spelling, or a "fires on every flush" mutant (the
  `snapshotApplied` gate removed — which would resolve the latch on the first post-reconnect flush and re-open (d)
  under non-atomic delivery) are text-caught or uncaught, never behaviour-caught. A runtime harness for
  connection.ts was rejected: the file is never imported under vitest, and an 18-table fake `DbConnection` reds on
  every table addition. The current-swap race — a `reconnectNow()`/`continueAnonymously()` re-entry between an
  armed `snapshotApplied` and its consuming flush reconciles against the NEW build's empty cache and still fires the
  signal — is a pre-existing class the shared batcher (ADR-0085 C2) already accepts.
- (g) **NEW** — `onHydrated`'s placement between `onReady` and `onReconnect` in main.ts is unenforced by any pin
  (the onReconnect-region slicers assert positives only); harmless if moved, recorded for completeness.
