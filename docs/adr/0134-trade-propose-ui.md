# ADR-0134 — Client trade-PROPOSE UI (KeyO offer overlay)

**Status:** Accepted
**Date:** 2026-07-20
**Slice:** pt-c2
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, economy-quests, movement-netcode

**Decision:** A `KeyO` ("Offer") overlay gives a human the FIRST entry point to *initiate* a trade
via the already-merged `propose_trade` reducer (M15/ADR-0106) — the existing `KeyU` overlay only
RESPONDS to an offer, which until now could only be created via the `__mrTrade` test hook (D-17.5-D /
H3). It mirrors the pt-c1b rename overlay (ADR-0133): a pure `tradeProposeModel.ts` + a fully
happy-dom-covered `tradeProposeView.ts` + `main.ts` wiring + a two-context UI-driven e2e. Because
monsters/inventory are PRIVATE (ADR-0015), the initiator cannot enumerate the counterparty's roster,
so the counterparty side is **`counterpartyCurrency` only**; item-offer rows, counterparty
monster/item requests, the help overlay, and `docs/PLAYTEST.md` are parked to **pt-c2b**.

---

## Context / problem
`propose_trade` (trading.rs:192) has no human UI. The trade overlay (`KeyU`, tradeView/tradeModel,
ADR-0107) renders the ACTIVE offer and offers accept/reject/confirm/cancel — but there is no way to
CREATE an offer without the DEV-gated `__mrTrade` hook. H3 (does trading feel valuable) is therefore
structurally untestable by a human tester. pt-c2 closes this loop-completeness gap.

## Decision detail

### D1 — KeyO overlay, mirroring pt-c1b (ADR-0133)
New key **KeyO** = "Offer". Keymap-collision audit (main.ts, mandatory per ADR-0133): TAKEN =
WASD+Arrows (movement), KeyB/KeyI/KeyE/KeyQ/KeyH/KeyG/KeyU(trade)/KeyP(pvp)/KeyL(leaderboard)/
KeyN(rename)/KeyT(talk), F8/F9/Space/Escape. FREE letter keys = C/F/J/K/M/**O**/R/V/X/Y/Z. KeyO chosen
(mnemonic). New files `client/src/ui/tradeProposeModel.ts` + `tradeProposeView.ts`; wired in `main.ts`
+ `client/index.html` (`#tradepropose-overlay`). The existing tradeView/tradeModel are UNTOUCHED.

### D2 — RLS forces a currency-only counterparty side (not merely "deferred")
Monsters (`monster`) and inventory are PRIVATE tables (ADR-0015). The initiator's subscription does
NOT contain the counterparty's monster/inventory rows, so the client CANNOT populate
`counterpartyMonsterIds` / `counterpartyItems` — this is IMPOSSIBLE from the client, not a scope cut.
The only counterparty-side field the initiator can meaningfully fill is `counterpartyCurrency` (a typed
number). The realizable trade shape is therefore "give my monster(s) + my gold, request your gold" — a
"sell a monster for gold" flow, the compelling H3 use case. `initiatorItems`, `counterpartyMonsterIds`,
`counterpartyItems` are always sent EMPTY this slice.

### D3 — Pure model is a projection + non-degeneracy gate, NOT a validation SSOT
`tradeProposeModel.ts` is TOTAL (never throws — it is called from the KeyO handler and from live DOM
`input`/`change` listeners; a throw would starve sibling store batch-listeners). It does NOT
re-implement server validation (join / self-trade / balance / ownership / active-trade) — the server is
the reject-not-clamp SSOT (renameModel D2 precedent). It produces:
- `targets`: `allPlayers()` MINUS self (`identity !== ownIdentity`) MINUS empty-identity rows; label =
  `name` or `'(unnamed)'` for the empty string; sorted lexicographically by identity (deterministic).
  `online` is NOT hard-filtered (server rejects a non-joined counterparty; over-filtering risks hiding
  a just-connected peer). `allPlayers()` includes the caller's own row, so the self-filter is required.
- `offerableMonsters`: from `ownMonsters(identity)`; label = nickname (else species name via speciesMap,
  else `Unknown (#id)`) + level; sorted ascending by `monsterId` (BigInt comparator). No party/box
  filter (server does not forbid trading a party monster; YAGNI).
- currency parse (see D5) → `parsedOfferCurrency` / `parsedRequestCurrency: bigint`.
- `canSubmit` = target exists in `targets` AND at least one of {≥1 monster selected,
  `parsedOfferCurrency > 0n`, `parsedRequestCurrency > 0n`}. This MIRRORS the server's
  `validate_proposal` non-degeneracy gate (`total_assets >= 1` across both sides — rules.rs:52-61), so
  `canSubmit` never permits an `EmptyOffer` server-reject. It is a UX gate, NOT a balance SSOT. A
  "request gold, give nothing" offer (only requestCurrency) IS server-valid (total_assets=1) and is
  allowed — the server, not the client, decides whether it is accepted.
- `proposeArgs: TradeProposeArgs | null` — `null` when `!canSubmit`; else `{ targetIdentity: string,
  initiatorMonsterIds: bigint[], initiatorCurrency: bigint, counterpartyCurrency: bigint }`. Identity
  stays a plain string here (SDK `Identity` is constructed at the main.ts boundary; the model never
  imports the SDK).

### D4 — main.ts owns ALL wiring; onSubmit consumes the model's typed args (no DOM re-derive)
The view's single `#submit()` path builds the VM from live DOM via `buildTradeProposeViewModel` (the
same SSOT as its live submit-enable) and passes `vm.proposeArgs` to `cbs.onSubmit(args)`. main.ts's
`onSubmit(args)` MUST use those typed args — it does NOT re-derive from the DOM (red-team M-4). It
gates on `conn === undefined || conn.linkFrozen()` FIRST (ADR-0085 A1), then calls
`reducers.proposeTrade({ counterparty: new Identity(args.targetIdentity), initiatorMonsterIds:
args.initiatorMonsterIds, initiatorItems: [], initiatorCurrency: args.initiatorCurrency,
counterpartyMonsterIds: [], counterpartyItems: [], counterpartyCurrency: args.counterpartyCurrency })`.
Success → feedback "Offer sent!"; reject → `reduceErrorMessage(err, 'propose-trade')` (no InternalError
leak). The model field `targetIdentity` maps to the reducer/hook field `counterparty` — only here.

### D5 — Currency parser: digit-only string scan → BigInt (never Number()/parseInt-floor)
`<input type=number>.value` returns the RAW string (browsers do not clamp min/max in JS). The parser
validates the string is all-ASCII-digits (non-empty) and only then `BigInt(s)`; anything else
(`''`, `'-1'`, `'0.5'`, `'1.9'`, `'abc'`, `'1,000'`, `'1e30'`) → `0n`. NOT `BigInt(Number(v))` (IEEE-754
truncates large values) and NOT `BigInt(parseInt(v,10))` (`'1.9'` → `1n`, silently wrong). This keeps
the model TOTAL and the parse exact.

### D6 — Input hygiene (renameView D3 contract) on EVERY focusable
`stopPropagation` on the `keydown` of the target `<select>`, EACH monster checkbox, BOTH currency
`<input>`s, and the submit `<button>` (so Arrow/WASD keys never bubble to the window movement/hotkey
listener — red-team H-2: a focused `<select>` scrolled with arrows would otherwise walk the character).
The currency inputs additionally handle Enter=submit / Escape=hide locally. `show()` defers
`setTimeout(() => targetSelect.focus(), 0)` and REBUILDS the monster-checkbox container from the current
`offerableMonsters` (authoritative rebuild — a monster traded away since the last open must not linger,
red-team M-2). `hide()` resets the select to placeholder, unchecks all monsters, blanks both currency
inputs + feedback, and releases the in-flight lock (`#pending=false`, submit re-enabled — dead-button
guard, ADR-0085 C6). Single `#submit()` with `#pending` re-entrancy guard; `void
Promise.resolve(onSubmit(args)).finally(reset).catch(swallow)` (unhandled-rejection guard — vitest fails
the run otherwise). Player-controlled `name`/`nickname` → `textContent`/`option.textContent`/`value`
ONLY, NEVER innerHTML (XSS firewall; the dynamic checkbox-label path is the risk site — tested with a
`<script>`-bearing nickname).

### D7 — The mutual-exclusion FAN-OUT is an enumerated checklist (not "~20 sites")
Every `renameView?.visible` guard site gets a sibling `tradeProposeView?.visible`; every
`renameView?.hide()` force-hide site gets a sibling `tradeProposeView?.hide()`. Exact main.ts sites
(worktree line numbers at plan time), each a mutual-exclusion HOLE if missed:
- **Open guards** (add `!tradeProposeView?.visible`): 495 KeyB, 514 KeyI, 533 KeyE, 557 KeyQ, 581 KeyH,
  606 KeyG, 639 KeyU, 672 KeyP, 702 KeyL, **733 KeyN** (reviewer B-1 — easy miss), 763 KeyT.
- **KeyO handler** (NEW): 12-sibling self-guard (all existing overlays) + `identity !== ''` guard
  (red-team L-1) + `held.clear()` + `e.preventDefault()` + toggle-close.
- **Escape branch** (NEW, placed adjacent to the rename branch at 790 — text-input overlays get highest
  Escape priority): `if (Escape && tradeProposeView?.visible) { hide(); preventDefault(); return; }`.
- **Movement / reissue suppression** (add `tradeProposeView?.visible`): 397 reconcile-divergence guard,
  874-887 movement-block, 1853-1867 frame-loop re-issue guard.
- **PvP auto-show** (add `tradeProposeView?.visible`): 1113-1124 batch-listener `anyOverlayVisible`
  (reviewer B-2 / red-team C-1 — a server-push auto-show, easy to miss).
- **Force-hide** (add `tradeProposeView?.hide()`): 963 battle auto-show (red-team L-2), **~1803
  onReconnect** (reviewer M-2 / red-team C-2 — WITHOUT this the `#pending` lock survives a link drop →
  dead submit button forever).

### D8 — e2e drives the REAL propose UI (teeth)
`client/e2e/trade-propose.spec.ts` (two-context): the INITIATOR opens KeyO, selects the counterparty in
the `<select>`, checks its starter monster, and CLICKS submit — pure DOM, NOT `__mrTrade` (red-team
L-3). The counterparty responds+confirms via `__mrTrade`. Asserts the SPECIFIC checked `monsterId`
leaves the initiator and arrives at the counterparty (identity, not just conservation counts — red-team
H-5), and the offer row is deleted. This is the one test that proves the UI (not the hook) initiates a
trade — `trade-full.spec.ts` cannot.

### D9 — Coverage: tradeProposeView is FULLY covered, NOT excluded
Like renameView/leaderboardView-input overlays, `tradeProposeView.ts` is happy-dom unit-covered and is
NOT added to `vite.config.ts` `coverage.exclude` nor the dom-shell-coverage-exclusion eval's
`DOM_SHELLS` (pt-b1 "View can't be coverage-excluded" trap).

## Known limitations (accepted for the MVP playtest)
- The `"counterparty has insufficient currency for this trade"` SenderError (trading.rs) reveals that
  the counterparty holds LESS than the requested amount — a coarse wallet-balance side-channel via
  `reduceErrorMessage` (which correctly passes SenderErrors through and only strips InternalError). By
  varying `counterpartyCurrency` an initiator could binary-search the peer's balance. Accepted for the
  closed playtest; production hardening would need an opaque rejection (record for post-gate).
- Offline players appear in the target `<select>` unlabeled (D3 — no `online` hard-filter). Selecting
  one yields a `"counterparty is not a joined player"` reject. UX-only; no new information leak (the
  target list is public data).

## Consequences
- H3 becomes human-testable; the trade loop is UI-complete for monster↔gold trades.
- Adds one overlay to the mutual-exclusion fan-out (the D7 checklist is the maintenance cost).
- No schema, reducer, game-core, or dependency change — client-only, additive.

## Alternatives considered
- **Extend the KeyU overlay** with a propose mode (show the form when no active offer). Rejected: it
  entangles the RESPOND overlay (tradeView/tradeModel + their tests) and diverges from the proven
  pt-c1b separate-overlay pattern. A separate KeyO overlay is lower-risk and RL-preserving.
- **Let the counterparty add to the trade** (negotiation). Rejected: M15 escrow is propose-time-fixed
  (ADR-0106); the counterparty accepts/rejects. Out of scope.

## Deferrals → pt-c2b
Item-offer rows (qty inputs); requesting SPECIFIC counterparty monsters/items (RLS-impossible from
client — D2); in-client help/controls overlay; `docs/PLAYTEST.md` tester runbook.
