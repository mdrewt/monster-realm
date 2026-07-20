# pt-c2 — in-client trade-PROPOSE core (ADR-0134) — build plan

Slice: pt-c2 (M-playtest-c UX completion). ADR reserved: 0134. Client-only, main.ts SERIAL.
Resolves D-17.5-D / H3 (trading untestable e2e without a way to *initiate* a trade).

## Summary
Add a NEW `tradePropose` overlay on **KeyO** ("Offer") that lets a human initiate a
"sell my monster(s) + my gold for your gold" trade via `reducers.proposeTrade`, mirroring
the pt-c1b rename overlay pattern (pure model + fully-covered DOM shell + main.ts wiring +
two-context e2e). RLS (ADR-0015: monsters/inventory PRIVATE) makes requesting SPECIFIC
counterparty monsters/items impossible from the client, so the counterparty side is
`counterpartyCurrency` only. Item-offer rows, help overlay, and `docs/PLAYTEST.md` are PARKED
to pt-c2b.

## Functional-core / imperative-shell
- **Pure core** `client/src/ui/tradeProposeModel.ts` — TOTAL/never-throws pure projection:
  targets (allPlayers minus self/empty, `'(unnamed)'` fallback, sorted by identity),
  offerableMonsters (ownMonsters, label from nickname/species, sorted by monsterId),
  total currency parsers (digits→BigInt else 0n), `canSubmit` (target exists + ≥1 thing
  offered/requested), `proposeArgs | null`. No SDK, no store handle, no re-implementation
  of server validation (second-SSOT anti-pattern).
- **View** `client/src/ui/tradeProposeView.ts` — happy-dom-covered DOM shell mirroring
  renameView: textContent/value only (XSS firewall), stopPropagation on every focusable,
  live submit-enable, deferred focus, hide() resets draft+feedback+#pending, single #submit()
  with #pending lock + `.finally().catch()`.
- **main.ts** — KeyO handler (12-sibling guard + held.clear + preventDefault), Escape branch,
  dynamic-import + instantiation + onSubmit (frozen-gate FIRST per ADR-0085, `new Identity()`
  + bigint arrays at the boundary, `reduceErrorMessage` no-leak), and the full ~20-site
  `tradeProposeView?.visible` mutual-exclusion fan-out + force-hide sites.
- **index.html** — overlay shell: `#tradepropose-overlay` with target `<select>`, monster
  checkbox container, offer/request currency `<input type=number>`, submit button, feedback
  (stable ids + `data-testid`s).

## Cross-boundary contract
```ts
interface TradeProposeArgs {
  readonly targetIdentity: string;                 // main.ts → new Identity(...)
  readonly initiatorMonsterIds: readonly bigint[];
  readonly initiatorCurrency: bigint;
  readonly counterpartyCurrency: bigint;
}
```
main.ts fills `initiatorItems:[]`, `counterpartyMonsterIds:[]`, `counterpartyItems:[]`.

## EARS criteria PTC2-1..16
Model: 1 targets(self/empty excluded, unnamed fallback); 2 targets deterministic sort;
3 offerableMonsters + label + monsterId sort; 4 total currency parse (empty/NaN/neg/non-int→0n,
never throw); 5 canSubmit (target-exists + ≥1 offered/requested); 6 proposeArgs shape / null;
7 model TOTAL never-throws.
View: 8 render textContent-only + submit disabled=!canSubmit; 9 stopPropagation on every
focusable + Enter/Escape local; 10 live submit-enable on change; 11 show()=deferred focus,
hide()=reset draft/feedback/#pending; 12 single #submit() #pending lock + finally-reset + catch.
main.ts: 13 KeyO opens only when no other overlay (toggle/held.clear/preventDefault);
14 fan-out (every guard + suppression + reconcile + pvp anyOverlayVisible + force-hide) +
Escape priority; 15 onSubmit frozen-gate FIRST + Identity/bigint + reduceErrorMessage no-leak.
e2e: 16 UI-driven propose (KeyO→select→check monster→submit) → __mrTrade respond+confirm →
monster transfers (conservation) + offer row deleted.

## Decisions (→ ADR-0134)
- **KeyO** chosen ("Offer"); keymap audit: taken = WASD+arrows, KeyB/I/E/Q/H/G/U/P/L/N/T,
  F8/F9/Space/Escape; KeyO free.
- Counterparty side = `counterpartyCurrency` only (RLS: initiator cannot enumerate peer roster
  — requesting specific peer monsters/items is IMPOSSIBLE from client, not merely deferred).
- Do NOT hard-filter targets on `online` (server rejects non-joined counterparty; over-filter
  risks hiding a just-connected peer whose online flag lagged a batch).
- No party/box filter on offerable monsters (server does not forbid trading party monsters; YAGNI).
- `canSubmit` is a UX gate, NOT server validation (reject-not-clamp SSOT stays server-side).

## Named deferrals → pt-c2b
(a) item-offer rows (qty inputs); (b) requesting SPECIFIC counterparty monsters/items
(RLS-impossible from client); (c) in-client help/controls overlay; (d) `docs/PLAYTEST.md`.

## touches (SERIAL — main.ts fan-out not fan-out-eligible)
new: tradeProposeModel.ts(+test), tradeProposeView.ts(+test), e2e/trade-propose.spec.ts,
docs/adr/0134-*.md; edit: main.ts, index.html, ARCHITECTURE.md; regen: docs/knowledge/**.
NO CHANGELOG/adr-README hand-edit; NO server/schema/game-core.

## Tasks
T1 ADR-0134 + collision audit · T2 model tests RED · T3 model GREEN · T4 view tests RED ·
T5 index.html shell + view GREEN · T6 e2e RED · T7 main.ts wiring + fan-out GREEN · T8 close-out
(`just knowledge`, full `just ci`).

## Plan-review resolution (reviewer + red-team → folded into ADR-0134)
Authority for finalized decisions is **ADR-0134**. Folded:
- **Enumerated fan-out checklist** (D7) — exact main.ts line list incl. the easy-miss **KeyN guard 733**,
  the **PvP batch-listener anyOverlayVisible 1113-1124**, and the **onReconnect force-hide ~1803**
  (dead-#pending-lock fix). A `main.wiring` source-scan test gates the whole checklist.
- **Currency parser** (D5) — digit-only string scan → BigInt; `'0.5'/'1.9'/'-1'/''/'abc'/'1,000'/'1e30'`
  → `0n`; `'1'/'100'` → `1n/100n`. Never `Number()`/`parseInt`-floor.
- **canSubmit** (D3) confirmed CORRECT/permissive — mirrors server `validate_proposal` `total_assets>=1`
  (rules.rs:52-61); never allows an EmptyOffer reject.
- **stopPropagation on EVERY focusable** (D6): select + each checkbox + both number inputs + submit.
- **KeyO guards `identity !== ''`** (D7); **show() rebuilds the monster container** (D6, stale-monster).
- **e2e** (D8): propose leg is pure-UI (KeyO→select→check→submit); assert the SPECIFIC monsterId
  transfers (identity, not just conservation count).
- **XSS** (D6): dynamic checkbox labels textContent-only — view test with a `<script>` nickname.
- **coverage** (D9): tradeProposeView NOT excluded (fully happy-dom covered).
- Known privacy limitation (counterparty-insufficient-currency SenderError) documented in ADR-0134.
