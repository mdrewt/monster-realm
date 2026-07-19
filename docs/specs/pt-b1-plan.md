# pt-b1 — client error overlay + event ring + F9 bug bundle (build-time slicing pass)

**Milestone:** M-playtest-b (observability & feedback; M20 pull-forward) · **Slice:** pt-b1
(client-only) · **ADR:** 0130 · **Off master:** abafb54 · **Model:** opus

## Scope (this slice)
Three interlinked client-only features on the M13.5 UX seam:
1. **Error overlay** — dismissible, non-blocking; unifies uncaught-error + unhandled-rejection +
   reducer-rejection surfacing; timestamped **error ring** (capped).
2. **Event ring** — structured capped buffer of the H1/H2/H3 proxy taxonomy (ADR-0130), identity-hex
   only (no names/PII).
3. **F9 bug bundle** — one keypress downloads `{buildSha, identity, zone, event ring, error ring,
   key store snapshot}` as JSON via Blob (NO network).

**Right-size = CORE + PARK** (recommended, accepted). Wire the 6 cheap/store-delta events now;
commit the full 14-variant taxonomy in ADR-0130; park the 8 handler-wired/correlation events to
**pt-b1b**. **pt-b2** (additive `playtest_event` schema + reducer hooks + reaper + `just
playtest-report`) is SERIAL/structural, out of scope.

## touches (strict)
`client/src/ui/*` (new: `eventRing.ts`, `errorRing.ts`, `bugBundle.ts`, `errorOverlayModel.ts`,
`errorOverlayView.ts` + `.test.ts` each), `client/src/main.ts` (wiring), `client/src/main.wiring.test.ts`
(source-scan teeth). Docs: `docs/adr/0130-*.md`, `docs/knowledge/**` (regen), `ARCHITECTURE.md`.
**NOT touched:** `vite.config.ts`, `index.html`, `client/src/net/*` (incl. store.ts — observed only,
not modified), `evals/**`, `buildInfo.ts` (reused).

## Functional-core / imperative-shell split
- **Pure (fully unit-tested, coverage-counted):** `eventRing` (capped ring + `PlaytestEvent` union +
  `makeEvent*` constructors, injected clock), `errorRing` (capped ring + `normalizeError`),
  `bugBundle` (`buildBugBundle`/`serializeBugBundle`/`bugBundleFilename`, bigint-safe),
  `errorOverlayModel` (`buildErrorOverlayModel`).
- **Shell View (fully unit-tested via happy-dom — CANNOT be coverage-excluded):** `errorOverlayView`
  (self-mounting, `show/hide/dismiss/toggle/visible`, textContent/dataset only).
- **Shell wiring (main.ts — coverage-excluded, SOURCE-SCAN-guarded):** window error/rejection
  listeners; `reportError` augmentation; overlay mount; F9 branch (sentinel-delimited
  `// F9-BUNDLE-BEGIN/END`); 6 core event emit-sites; dismiss key.

## EARS acceptance criteria
Ubiquitous: **U-1** event ring capped+oldest-evicted · **U-2** error ring capped+oldest-evicted ·
**U-3** no name/free-text in any event payload (identity-hex/ids/numbers only) · **U-4** overlay
textContent/dataset only, never innerHTML · **U-5** no `new RegExp` in pt-b1 files · **U-6** no writes
to game-core / rule paths.
Event: **E-1/E-2** window error/unhandledrejection → error ring + overlay · **E-3** `reportError` →
error ring + overlay AND keeps `#status`+console.error · **E-4** onReady → `connect(identity)` ·
**E-5** onError(where==='link') → exactly one `disconnect` · **E-6** switchZone commit → `zoneChange`
· **E-7** new-battle latch edge → `battleStart` · **E-8** first non-Ongoing outcome → `battleEnd` ·
**E-9** own `profile.rating` change → `rankedMatch(ratingDelta)` · **E-10** F9 → assemble + download
bundle with no network · **E-11** dismiss key while visible → hide + no gameplay forward.
State: **S-1** overlay non-blocking while visible · **S-2** F9 works while connection broken · **S-3**
overlay hidden while no errors.

## Proof-of-teeth
Pure: T-CAP-1 (event ring evict), T-NOPII-1 (no name key/value), T-HP-1 (permille round/clamp/div0),
T-ECAP-1 (error ring evict), T-NORM-1 (normalizeError truncate/total), T-BUNDLE-1/2/3 (shape/JSON
bigint/no-PII), T-VM-1/2 (empty/hidden-count), T-VIEW-1..5 (self-mount / visibility / XSS /
render-unify / non-blocking).
Source-scan (`main.wiring.test.ts`, indexOf/includes, no `new RegExp`, fail-loud): W-F9-NONET (F9
region has no fetch/XHR/WebSocket/sendBeacon/.reducers.), W-F9-BLOB (positive control:
createObjectURL present), W-UNIFY-1 (reportError keeps status+console AND pushes ring), W-LISTEN-1
(error+unhandledrejection registered), W-EMIT-1 (6 core emit needles present).

## Anti-patterns forbidden
Unbounded buffers · PII leak (names/free text) · network in F9 path · determinism perturbation ·
blanket catch{} · innerHTML with data · `new RegExp` · blocking/focus-trapping overlay ·
index.html dependency · premature abstraction (YAGNI) · coverage-excluding the new View.

## Observation sites (pt-b1 core) — corrected per plan review
- **connect** → `onReady` (main.ts:1496) **AND** `onReconnect` (:1500, using retained module
  `identity`) so a reconnect isn't a dangling disconnect.
- **disconnect** → `onError` callback with `where === 'link'` string-equality guard ONLY (:1532).
  NOT in `reportError` (the callback also gets where∈{connect,subscribe,join} on retry — must not
  emit). Single-fire per connection.ts:147 `wasConnected`; redundant bfcache fire (:175) is an
  acceptable real drop. connection.ts is OUT of touch-set — no new callback.
- **zoneChange** → `switchZone` commit (:236), from = prior `rawMap.zone_id`.
- **battleStart** → own `lastBattleId` latch: emit when `latest.battleId` changes; guard
  stale-terminal-at-first-sight (mirror `decideBattleOverlay`). **battleEnd** → own `lastBattleOutcome`
  latch: emit on first Ongoing→terminal per battleId. Both reset in `resetPredictionState()`.
- **rankedMatch** → its OWN **unconditional** `store.onBatchApplied` listener (NOT the
  visibility-gated leaderboard listener :986 — it early-returns while the board is closed and misses
  matches). `lastOwnRating` latch, first-sight-no-emit, reset in `resetPredictionState()`.
- All emit sites early-return on `identity === ''` (cold-start content batches precede the own row).

## Plan-review reconciliation (reviewer + red-team, folded into ADR-0130)
- **B-1/H-1 rankedMatch**: dedicated unconditional listener + `lastOwnRating` (was: gated leaderboard
  listener → missed matches). battleStart/End get own latches, reset-on-reconnect (was: reuse
  battleSynced/dismissedBattleId — wrong state; fires per-batch; reset() desync).
- **B-2 error ring**: ALL sources via `normalizeError` + `ERROR_MSG_MAX_LEN` cap (leak containment);
  no-PII tooth covers error ring; window handlers re-entrancy-guarded (scoped catch + already-handling
  latch); overlay render total.
- **H-2/H-3 bundle PII**: key store snapshot = enumerated non-PII scalar allowlist; `buildBugBundle`
  takes pre-projected name-free snapshot; canary-VALUE tooth (not just key-absence).
- **H-2 no-network**: `bugBundle.ts` pure, imports nothing from net/*; scan covers bugBundle.ts +
  main.ts F9 region; ban needles += conn / import( / sendBeacon.
- **M-1 connect-on-reconnect**; **M-3 bigint-total serializer** (replacer); **M-4 CSP fallback**
  (catch → console.log JSON + surfaced msg); **caps pinned** EVENT_RING_CAP=256 / ERROR_RING_CAP=64;
  **L-2** W-EMIT-1 uses 6 distinct constructor needles; **L-1** exact post-burst ring content asserts.

## Tasks
0. ADR-0130 (done, this checkpoint). 1. tester: RED pure tests. 2. specialist: implement pure core
green. 3. tester: RED source-scan teeth in main.wiring.test.ts. 4. specialist: wire main.ts green.
5. review lenses + full `just ci` + doc-keeper (ARCHITECTURE, knowledge regen, memory, spec tick).

## Parked / follow-ups
- **pt-b1b:** the 8 handler-wired emit-sites (preRecruitHp, recruitAttempt, recruitResult, boxOpen,
  monsterRelease, reCatch, tradePropose, tradeConfirm) + delta-tracking + constructor emit tests.
- **pt-b2:** additive `playtest_event` server table + hooks + reaper + `just playtest-report`.
