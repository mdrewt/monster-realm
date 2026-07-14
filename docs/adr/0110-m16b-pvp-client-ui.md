# ADR-0110 — PvP client UI (m16b)

**Status:** Accepted
**Date:** 2026-07-14
**Slice:** m16b
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui
**Decision:** `pvpModel.ts` + `pvpView.ts` + `main.ts` KeyP flow. `battle_challenge` subscribed; `battle_action` NEVER subscribed (ADR-0015). `pvpPendingTurnNumber` local tracking. `isPvP = !isWild && ids differ`; `canFlee: false` in PvP.

---

## Context

ADR-0109 (m16a) landed the PvP server spine — `battle_challenge` table,
`challenge_pvp` / `accept_challenge` / `decline_challenge` / `cancel_challenge` /
`submit_pvp_action` reducers, and `start_pvp_battle` wiring. The PR deferred all
client-side work. This slice delivers the client tail:

- Subscribe to `battle_challenge` and surface challenge/accept/decline/cancel flows
- Surface `submit_pvp_action` turn UI on the shared `battle` row
- Show "Waiting for opponent" pending-submit banner, forfeit-on-disconnect outcome

**Critical invariant (ADR-0015):** `battle_action` is PRIVATE and must never be
subscribed or read by the client. The client tracks its own submission state via a
local `pvpPendingTurnNumber` variable cleared when `battle.turnNumber` advances.

## Decision

### D1 — StoreBattleChallenge + store methods

`StoreBattleChallenge` is a normalized type (identities as hex strings, status as
`string` tag) added to `store.ts` above `StoreTradeOffer`. The store maps
`#challenges: Map<bigint, StoreBattleChallenge>` with `upsertChallenge`,
`removeChallenge`, `allChallenges()`, and `allPlayers()` accessors (mirroring the
trade-offer pattern from m15b / ADR-0107).

### D2 — battle_challenge subscription (NEVER battle_action)

`connection.ts` subscribes `SELECT * FROM battle_challenge` with `onInsert` /
`onUpdate` / `onDelete` handlers. A comment in the subscription list explicitly
documents that `battle_action` MUST NEVER be subscribed (ADR-0015 must-never-leak).
Row conversion follows the `SdkBattleChallengeRow → StoreBattleChallenge` pattern
matching existing `rowConvert.ts` converters.

### D3 — pvpPendingTurnNumber local tracking

Since `battle_action` is private, the client tracks submission state locally:
- `pvpPendingTurnNumber: number | null` — set to `battle.turnNumber` on submit
- Cleared in `refreshBattle()` when `battle.turnNumber > pvpPendingTurnNumber`
- Cleared in `resetPredictionState()` on reconnect/zone-switch
- `pvpPendingSubmit = pvpPendingTurnNumber !== null` passed to `buildBattleViewModel`

### D4 — isPvP detection in battleModel.ts

`isPvP = !isWild && battle.playerIdentity !== battle.opponentIdentity`

Wild battles have `opponentMonsterIds.length === 0` and the server sets
`opponentIdentity = playerIdentity`. PvP battles have distinct identities. PvE
(trainer) battles use matching identities with non-empty `opponentMonsterIds`.

Consequences of isPvP:
- `canFlee: ongoing && !isPvP` — no flee in PvP
- `isPvP`, `pvpPendingSubmit`, `pvpOpponentName` added to `BattleViewModel` and
  `battleVMsEqual`
- Two new optional tail args to `buildBattleViewModel`: `pvpPendingSubmit=false`,
  `pvpOpponentName: string | null = null`
- Existing `makeBattle()` test fixture updated to `opponentIdentity: 'alice'`
  (matching playerIdentity) so it represents PvE, not PvP

### D5 — pvpView.ts DOM shell pattern

`PvpView` reads existing DOM elements from `index.html` (same as `TradeView`,
ADR-0107): `#pvp-challenge-overlay`, `#pvp-challenge-status`,
`#pvp-challenge-incoming`, `#pvp-challenge-outgoing`, `#pvp-player-list`,
`#pvp-challenge-feedback`.

`refresh(vm, forceVisible)` auto-shows on incoming challenge or when `forceVisible`
(KeyP open or already-visible preserve). Auto-hides when no active challenge and not
forced. Registered in `vite.config.ts` coverage.exclude and
`evals/dom-shell-coverage-exclusion.eval.mjs` DOM_SHELLS.

### D6 — KeyP mutual exclusivity (9-way guard)

`KeyP` opens/closes the PvP overlay with a 9-way mutual-exclusivity guard (all prior
overlays). The PvP overlay is added to all existing overlay guards: KeyB/I/E/Q/H/G/U,
Escape chain, movement suppress, frame-loop suppress, reconcile diverge re-issue, and
`onReconnect` (`pvpView?.hide()`).

### D7 — PvP battle UI in battleView.ts

`BattleViewCallbacks` gains `onPvpAttack` and `onPvpSwap`. `battleView.refresh()`:
- Shows pending-submit banner when `pvpPendingSubmit && Ongoing`
- Hides skill/swap buttons while `pvpPendingSubmit` (locked UI prevents double-submit)
- Labels skills "Submit: <name>" and routes to `onPvpAttack` in PvP
- Labels swaps "Submit Swap: <name>" and routes to `onPvpSwap` in PvP

### D8 — submitPvpAction SDK shape

`PvpAction` is a BSATN enum: `{ tag: 'Attack' | 'Swap', value: number }` from
`__t.enum("PvpAction", { Attack: __t.u32(), Swap: __t.u32() })` in types.ts.
The `challengePvp` reducer takes `{ target: Identity, partyIds: bigint[] }` — the
`target` field requires SDK `Identity`, so main.ts wraps: `new Identity(targetIdentity)`.

## Review-pass findings (all resolved)

- **BLOCKER RT-M16B-01**: `pvpPendingTurnNumber` was set before `sendGuarded` ran its
  link-frozen check — a frozen-link click would permanently lock the battle UI.
  Fix: assignment moved inside the `sendGuarded` lambda; `.catch` clears it on rejection
  (mirrors the `dismissPending` pattern from dialogue dismiss).
- **WARNING RT-M16B-02**: pvpView batch auto-show had no battle-visible guard — pvpView
  could pop over an active battle or other overlay on incoming challenge.
  Fix: `anyOverlayVisible` guard added before setting `forceVisible=true`.
- **WARNING RT-M16B-03** (pre-existing m15b gap): KeyQ and KeyH guards were missing
  `!tradeView?.visible`; KeyT was missing both `!tradeView?.visible` and
  `!pvpView?.visible`. All three gaps closed in this slice.
- **MINOR RT-M16B-04**: KeyT guard was missing `!pvpView?.visible`. Fixed.

## Consequences

- `battle_action` was never subscribed. ADR-0015 invariant holds.
- PvP challenge and turn-submission flows are fully client-wired. No server changes.
- 934 tests across 34 files, all green.
- 7 e2e DOM/key/mutual-exclusivity tests in `pvp.spec.ts`.
- 58 evals PASS including `dom-shell-coverage-exclusion`.
- ADR next-free: **0111**
