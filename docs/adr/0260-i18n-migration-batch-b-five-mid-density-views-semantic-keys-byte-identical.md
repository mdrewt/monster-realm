# ADR-0260 — Migration batch B: `evolutionView.ts`, `raisingView.ts`, `boxView.ts`, `tradeView.ts` and `shopView.ts` resolve every player-facing string through `t()`/`tf()` with semantic keys, byte-identical English, and the ceiling ratchets 57 → 11 (M24 S4)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s4 (M24-internationalization S4 — migration batch B, the five mid-density views)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0257, 0259
**Subsystems:** client-ui, ci-gates
**Decision:** The five mid-density views call `t()`/`tf()` from the ONE flat catalog with semantic `evolution.*`/`raising.*`/`box.*`/`trade.*`/`shop.*` keys; English output is byte-identical; 46 failing sinks + 7 scanner-invisible hoisted literals migrate; `HARDCODED_CEILING` 57 → 11.

---

## Context

M24 §4 makes S4 the second of the three serial migration batches (`S3 → S4 → S5`, serial because all
three grow the single flat `MessageId` union and `catalog.en.ts` — the 2026-08-23 adversarial-review
correction). ADR-0259 fixed the pattern for S3: semantic keys, model data as params, byte-identical
English pinned at the catalog layer, a spy + sentinel routing oracle per view, a per-file zero-failing
scanner pin, and constructor-time strings resolved in `show()`. This ADR applies that pattern to the
five views the spec row names and records what differs.

**Population correction, measured with the real S2 scanner over comment-stripped source at 8e71e5d
(the m24-s0 / ADR-0259 precedent):** the spec row's "**77** sinks (13+17+15+16+16, E7)" is the TOTAL-sink
count, and its per-file split is off by one in two places — measured `evolutionView` 13, `raisingView`
**16**, `boxView` 15, `tradeView` 16, `shopView` **17** (total 77, so the E7 sum survives). Of those,
**46 FAIL** §2.2's rule (11 + 10 + 12 + 4 + 9). The ratchet counts FAILING sinks (ADR-0257 D5), so
`HARDCODED_CEILING` moves 57 → **11**, not 57 → −20. The 11 that remain are S5's tail plus `main.ts`'s
four (S6).

Seven further player-facing literals are structurally invisible to the scanner (function arguments and
`return` values, not sink right-hand sides): `tradeView`'s `'You offer'` / `'You receive'` (the
`#renderSide` heading argument) and its four `#actionLabel` returns (`'Accept'`, `'Reject'`,
`'Confirm Trade'`, `'Cancel'`), and `boxView`'s `prompt('New nickname:', …)`. They migrate with zero
ratchet effect; the per-view sentinel test is their only mechanical proof (ADR-0259 R4 class).

## Considered alternatives

1. **Split into S4a (evolution/raising/box) and S4b (trade/shop).** Rejected: both halves serialise on
   `messageIds.ts`/`catalog.en.ts` anyway, so a split buys a smaller review surface at the price of a
   second ADR, digest regen, ledger, lens chain and a second ceiling re-measure race with S6. trade and
   shop are the two simplest files (static `index.html` shells, no constructor-time strings, 13 failing
   sinks) — their marginal cost inside one PR is below the fixed cost of a PR.
2. **Gate row `${met ? '✓' : '•'} ${label}: ${current} / ${required}` as two plain mark keys** leaving
   the row a glyph-only compound. Rejected: it hands the translator two glyphs and no sentence, and
   leaves one more tier-(e) reorderability residual. Chosen: two whole-row `tf` keys
   (`evolution.gate.metRow` / `evolution.gate.unmetRow`, same params) with the ternary OUTSIDE the call
   (every `t(`/`tf(` first argument stays a string literal for S7's DYNAMIC-KEY gate). One text node in
   one element, so the m23s9 contrast census (`root.children.length === 3`, `s9TextElements`) is
   unaffected.
3. **Constructor-time strings written in the constructor AND re-written in `show()`.** Rejected as a
   redundant write. ADR-0259 R1's rule holds uniformly: the node is kept as a `readonly #…El` field and
   its text is resolved in `show()` — unconditionally, after the `wasVisible` read and before the
   display write, so a repeated `show()` on an already-open overlay re-resolves too (a
   `!wasVisible`-gated write would freeze the text across a mid-session locale switch; the routing tests
   call `show()` twice to pin this).
4. **Catalogue the model-produced strings** (`path.unmetReason`, `gate.label`/`currentText`/
   `requiredText`, `vm.statusLabel`, `vm.shopName`, `vm.balance.label`, `item.description`,
   `showFeedback` text). Rejected: they are model data (M24 §2.5) and their files are outside this
   slice's `touches:`; they stay params or untouched, tier-(e).
5. **Coerce bigint params to `number`/`string` at the call site.** Rejected: `trade.side.currency.amount`
   and `shop.buy.row`/`shop.sell.row`'s `price` keep their model type `bigint` — template interpolation
   of a bigint is byte-identical to the literal it replaced, and the type is the truthful contract.
   Consequence for tests only: the S3 sentinel mock's `JSON.stringify(params)` throws on bigint, so
   the trade/shop sentinel mocks carry a bigint → string replacer.

## Decision outcome

- **D1 Scope and bytes.** 46 failing sinks + 7 hoisted literals → 54 new keys (96 total). Every English
  value is transcribed from the pre-migration source bytes — including the trailing space in
  `shop.buy.row` / `shop.sell.row` (`… gold ` precedes the button), the ASCII `x` in
  `raising.card.train` / `raising.inventory.item` (`(x${count})`) versus the `×` U+00D7 in
  `shop.sell.*`, `—` U+2014, `→` U+2192, `★` U+2605, `✓` U+2713, `•` U+2022, and the `"To Party"`
  double quotes inside `box.hint`. `catalog.test.ts` pins every value for two sample-param sets that
  differ in every field.
- **D2 Key taxonomy.** `<namespace>.<screen-part>.<element>`, ADR-0256 D5 grammar. `*.row` / `*.line`
  / `*.stats` name a formatted text unit (parallel to `battle.card.hpLine`), not an HTML tag, so they
  survive ADR-0259 R3's "semantic, not mechanism" test. `trade.*` is the live-trade screen;
  `tradePropose.*` (S5) is the proposal dialog — `chrome.tradePropose.submit` already establishes the
  split, so there is no collision.
- **D3 Model data are params.** Every `MessageParams` row added is model data (species/nick/item
  names, tiers, stats, counts, prices) interpolated verbatim, never catalogued. `path.unmetReason ?? …`
  keeps its raw model text; only the `??` fallback (`evolution.path.allMet`) is catalogued.
- **D4 `show()` resolution for the three constructed views** (alternative 3). `evolutionView` title +
  hint; `raisingView` title + two section headings; `boxView` title, Heal Party button, hint, two
  section headings. `tradeView`/`shopView` render into static `index.html` shells and have no
  constructor-time strings. Cost: `boxView.test.ts`'s e2e-mirroring `e2eBoxRootOf` (which finds the
  `h2` by its text) cannot resolve the root before the first `show()`; the six pre-show sites use a
  structural `parent.firstElementChild` helper instead, every post-show site keeps the text anchor.
  `client/e2e/recruit.spec.ts` is unaffected — all its `h2['Party & Box']` queries already run inside
  a `waitForFunction` that requires `display !== 'none'`.
- **D5 `emptyRow(t('…'))` in `shopView`.** The helper stays (m24-s0 I18N-5 pins exactly one
  `createElement('li')` site). The scanner accepts the nested call because `exemptCallOpenAt`
  (`hardcodedStrings.ts`) tests only the character before `t`/`tf`, so a resolver call nested inside a
  sink argument contributes no segments.
- **D6 Proof shape (ADR-0259 D6/D7, strengthened).** Per view: `-01` routing (spy on
  `./i18n/resolver`, exact key + params per site, DOM bytes identical, a second `show()` re-requests
  the constructor-time keys), `-02` sentinel (construct before stubbing; explicit view-model matrix;
  whole-subtree walk; a `«key»` / `«key|params»` containment pin for EVERY migrated surface, plain and
  ★, the seven hoisted literals included; roster-word absence; post-restore control), `-03` per-file
  scan pin (`failing === []`, sink floor, no tripwires). The ratchet JSON moves to the measured 11 and
  the ledger's X1 pins that number independently of the self-consistency test.

## Consequences

- `HARDCODED_CEILING` 57 → 11. S5 owns the remaining view tail (S5's files + the two post-spec files);
  S6 owns `main.ts`'s four and takes the ceiling to its permanent 0.
- `catalog.test.ts`'s exact roster grows 42 → 96 (`EXPECTED_KEYS`); S5/S6 grow it again — a
  sibling-test companion, not a hidden dependency.
- Residual, shared infrastructure, NOT fixed here (outside `touches:`): the S2 scanner's
  `exemptCallOpenAt` does not reject `#` before `t`/`tf`, so `this.#t('raw English')` scans as an
  exempt call (red-team PoC: sinks 1, failing 0). For this slice the exhaustive per-site spy pins close
  it (a private `#t` never reaches the imported resolver); the one-line fix belongs to the scanner's
  owner and is registered as a residual.
- Residuals carried unchanged (pre-existing, not this slice's): `Slot ${i}: (empty)` shows a 0-based
  slot index; `#promptNickname` uses the native `prompt()` dialog; `(x${count})` in raising vs
  `(×${count})` in shop is an inconsistent count glyph — each is a reword or behaviour change that takes
  a fresh key or its own slice. The glyph-only compound rows the scanner already passes
  (`${nick} (${species})`, `${item.name} ×${item.qty}`, …) stay unkeyed (tier-(e) reorderability; the
  S7 French-spacing risk ADR-0259 named).
- `t(cond ? 'a' : 'b')` and a pass-through local `t` wrapper are indistinguishable to every oracle in
  this slice; they are banned by review until S7's DYNAMIC-KEY gate makes the ban mechanical.

## Lenses

planner → reviewer ∥ red-team ∥ /simplify (plan) → tester ×2 (disjoint files, RED) → reviewer ∥ red-team
(tests) → specialist → reviewer(+/simplify) ∥ verifier → doc-keeper. Domain auditors n/a (no
server / game-core surface). Lens outcomes are recorded in the PR body and the harness plan file
`memory/projects/monster-realm-m24-s4-plan.md`.
