# ADR-0263 — The proof locale: `catalog.fr.ts` authored end-to-end with a real CLDR plural, and the §5.3 catalog-parity gate as a co-located vitest census (M24 S7)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s7 (M24-internationalization S7 — the proof locale + the parity gate)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0262
**Subsystems:** client-ui, ci-gates
**Decision:** `catalog.fr.ts` is total over `MessageId`, registered in `CATALOGS`, and authors `battle.weather.banner` via `selectPlural`+`cldr`; `[I18N-PARITY-01..04]` ships as `catalogParity.test.ts`, resolving `t`/`tf` locals from imports.

---

## Context

M24 §4 row S7 is the milestone's proof slice: a second locale authored end-to-end, plus the §5.3
parity gate (I18N-26 `PARITY-GAP`, I18N-27 `DYNAMIC-KEY`, I18N-28 `DEAD-KEY`) the spec names as
`evals/i18n-catalog-parity.eval.mjs`. S1–S6 delivered the seam it exercises: the `MessageId` union
and the total `Catalog` type (ADR-0256 D2/D7), `selectPlural`/`cldr`/`oneOther` (ADR-0256 D2), the
resolver's frozen registry with a comment reading "S7 adds `fr` here" (`resolver.ts:36-38` at
`72e638d`), and the boot wiring that negotiates against `Object.keys(CATALOGS)` so a registered
locale wires itself with no `main.ts` edit (ADR-0262). ADR-0262's consequences fixed three S7
obligations: `fr` is `{one, many, other}` under node 24's ICU so the catalog may not call
`oneOther` (SHAPE-06); the DEAD-KEY roster exempts exactly `chrome.helpHint` (D5); and the census
must resolve local names from each file's import specifiers because `main.ts` binds a11yCopy's `t`
bare and the resolver's `t` as `i18nT` (D3).

Facts that shaped the slice: (1) `CONTENT_VERSION` is **22** at HEAD (`server-module/src/lib.rs:87`,
rb-82), not the spec's 21 — I18N-31/E11 are stale. (2) The declared `touches:` (catalog.fr.ts + the
JSON baseline) cannot be green alone: `catalogShape.test.ts:113-126` reds every SHAPE gate when a
discovered `catalog.*.ts` is not in `CATALOGS`, so `resolver.ts` must register `fr`. (3) Every en
closure is a single unconditional template that reads each param field exactly once.

## Considered alternatives

- **`evals/i18n-catalog-parity.eval.mjs`** — rejected; ADR-0224 retired new evals and S0/S2/S6
  (ADR-0255/0257/0262) already substituted co-located vitest tests.
- **A static `import { CATALOG_FR } from './catalog.fr'` in the gate for RED** — rejected: a
  module-resolution error reds the whole file, so the seven fixture tests could not prove their teeth
  at HEAD. RED comes from the registry pin `['en','fr']` and `CATALOGS.fr` being undefined (five
  live tests red, seven fixture tests green — measured).
- **A bare-global `t(`/`tf(` text scan** — rejected: it conflates `main.ts`'s a11y `t` with the i18n
  `i18nT`, reporting `a11y.world.region` as UNDEFINED-KEY and the six `chrome.status.*` keys as dead.
- **Accepting a no-substitution template literal as a literal key** — rejected: the spec says
  "string literal"; zero production instances; refusing every backtick removes a `${`-walker class.
- **UNDEFINED-KEY against the union `MessageId ∪ a11y`** (the spec's letter) — rejected for a
  per-binding check: an `a11y.*` key through the i18n resolver throws at runtime (`resolver.ts:64`).
- **Raw `${p.turns} tours`** (option A) — rejected: the proof slice's point is to run the plural seam
  against a >2-category locale once for real; French differs from English exactly where `n === 1`
  is wrong (CLDR fr `one` covers 0 and 1).
- **`oneOther` for fr** — forbidden by SHAPE-06; **per-key French byte pins written by the tester** —
  rejected (the test pins shape, field sets and a ≥100-of-112 differ floor, not prose); **`fmtNumber`**
  — YAGNI, digits stay raw; **translating a11y copy** — M23 owns it (§2.4).
- **Stopping on the resolver.ts hidden dependency** — rejected: no sibling in flight (worktree list
  and open PRs empty), S7 is declared parallel-ineligible, and the file's own comment named this
  edit. Widening is disclosed in the PR's `touches-delta:`.

## Decision

- **D1 Vehicle.** `client/src/ui/i18n/catalogParity.test.ts`, discovered by `src/**/*.test.ts` and
  run by `just ci`'s client stage. Zero `RegExp` (ADR-0055/0256), `stripComments` imported from its
  single owner (`evals/dom-shell-coverage-exclusion.eval.mjs`, ADR-0215), `describe(name,
  { sequential: true })`, every BAD/GOOD/vacuity fixture asserted exactly once, no meta-check of the
  test itself.
- **D2 Registry widening, disclosed.** `resolver.ts` imports `CATALOG_FR` and freezes
  `{ en, fr }`; `resolver.test.ts` pins `Object.keys(CATALOGS).sort()` to `['en', 'fr']`. Still no
  runtime `registerCatalog` hook (ADR-0256 D1).
- **D3 The census.** Walk `client/src/**/*.ts` minus `.test.ts`; per file parse every
  `import { … } from '<spec>'` statement (single- or multi-line, quote-aware) whose specifier ends
  in `/i18n/resolver`, `/i18n/resolver.ts`, `/i18n/resolver.js` or is `./resolver[.ts]` (module
  `i18n`) or ends in `/a11yCopy[.ts|.js]` (module `a11y`); record `local → {module, orig}` for
  `orig ∈ {t, tf}`, ignoring `type` items. A call is the local name at identifier boundaries, in
  code context (a literal mask whose `${…}` payload is code, recursively), not preceded by `.`,
  then optional whitespace / one balanced `<…>` / `?.`, then `(`. The first argument is LITERAL
  only when it is a single- or double-quoted string followed (after whitespace, newlines included)
  by `,` or `)`; anything else — any backtick, identifier, concatenation, conditional, `as const`,
  parenthesised, empty — is a `DYNAMIC-KEY` finding, never a skip.
- **D4 Findings.** `PARITY-GAP` = for every registered locale, `MESSAGE_IDS − keys(catalog)` and
  `keys(catalog) − MESSAGE_IDS`, each naming locale, key and direction; `MESSAGE_IDS` is parsed from
  `messageIds.ts` source (the first `export type MessageId =` block, `| '…'` rows, comment-stripped)
  and must equal `Object.keys(CATALOG_EN)` in length — the belt against a `Partial`/`as` escape.
  `UNDEFINED-KEY` is per binding (i18n ∉ `MESSAGE_IDS`; a11y ∉ `keys(a11yCopy)`).
- **D5 DEAD-KEY roster.** `MESSAGE_IDS − requestedI18nLiterals − EXEMPT`, `EXEMPT =
  ['chrome.helpHint']` pinned to exactly one entry, and a requested exempt key is a
  `STALE-EXEMPTION` finding.
- **D6 Live-tree assertions, not rosters.** The live PARITY-02 test asserts the i18n-bound
  `DYNAMIC-KEY` finding list is `[]` directly, and pins the only dynamic a11y sites to the exact
  roster `ui/announcements.ts` + `ui/overlayA11y.ts` (M23's registry-driven `OVERLAY_A11Y[id].labelKey`
  lookups, ADR-0205) so a third is a loud red. The verifier's own mutant forced this: swapping
  `t('claim.privacyButton')` for a backtick at ONE of that key's two requesters survived 3368 tests
  when the test only pinned the 19-file importing roster and `main.ts`'s key sets — DEAD-KEY never
  fired (the second requester kept the key alive) and UNDEFINED-KEY never fired (the key was
  unchanged). Replayed after the fix: killed.
- **D7 The plural.** `battle.weather.banner` is `${label} (${turns} ${selectPlural('fr', turns,
  WEATHER_TURN_FORMS)})` with `WEATHER_TURN_FORMS = cldr({ zero: 'tour', one: 'tour', two: 'tours',
  few: 'tours', many: 'de tours', other: 'tours' })` — property names unquoted (a quoted `'one':`
  line parses as a catalog entry under SHAPE-01). CLDR fr `many` is the 10⁶ case and takes the
  partitive (« 1 000 000 de tours »); the three categories fr never selects mirror the nearest live
  form. FR-02 asserts the forms for 0 and 1 match, 1 and 2 differ, and 10⁶ and 2 differ, comparing
  the text after the last digit — the plan's `many: 'tours'` and the test's first last-word
  extractor were jointly unsatisfiable under correct French (found by the red-team writing the
  cheat and by the specialist independently).
- **D8 French typography.** Real U+00A0 before `:` `;` `!` `?` `%` and inside « »; `’` U+2019;
  `…` U+2026; sentence case with accented capitals; every en glyph kept (`· — → ✓ • ★ ×`), the
  trailing space in `shop.buy.row`/`shop.sell.row` and the leading ` — ` in `leaderboard.row` kept;
  key names Esc/B/M/?/F8/F9 untranslated; Lv→Niv., HP→PV, Acc→Préc., W/L→V/D; params are model
  data interpolated verbatim; `chrome.helpHint` = `? pour l’aide · clic ou M pour le menu` (38 code
  points, budget 47). 107 of 112 values differ from en; the five glyph/proper-noun equals are
  `battle.skill.pveLabel`, `pvp.title.idle`, `evolution.path.heading`, `raising.inventory.item`,
  `evolutionNotice.ok`.
- **D9 Runtime proof.** FR-01 calls every en/fr closure pair with a recording `Proxy` under two
  sentinel families, asserts the accessed field sets are equal and every field is interpolated,
  counts ≥100 differing values, and checks `Object.isFrozen`. FR-03 pins `box.hint` quoting its
  locale's `box.card.toParty` and `setLocale('fr')` redirecting `t()`. PLURAL-01 pins
  `Intl.PluralRules` categories per registered locale (`en` {one, other}; `fr` {one, many, other})
  with the table's key set equal to the registry.
- **D10 I18N-31 at 22.** The ledger pins `CONTENT_VERSION` unchanged at 22 and the schema/content
  baselines byte-identical to the slice base; the spec's "21" is a supervisor-side correction.

## Consequences

- Adding a locale now takes four edits: `catalog.<tag>.ts`, the `resolver.ts` registration, a
  `PLURAL_CATEGORIES` row in `catalogParity.test.ts`, and the `resolver.test.ts` registry pin.
- S8 must serialise a `selectPlural` closure as an ICU `{turns, plural, …}` message and treat
  `WEATHER_TURN_FORMS` as catalog data, not code.
- Accepted limits, all fail-loud or out of reach today: `obj.t(…)` receivers (and whitespace around
  the dot) are not the binding; re-exports and dynamic `import()` of the resolver are invisible to
  the import parser; calls outside `client/src/**/*.ts` are not walked; a renamed local helper that
  fills categories with `other` evades the name-based SHAPE-06 — FR-02-style per-key
  category-distinctness is the real backstop for any future plural key; FR-01's field-set equality
  assumes branch-free closures (true of every entry today — a closure that branches on a param
  needs a second, field-varying sample).
- French players still see English a11y names (M23 copy), the static English `#help-hint`
  (ADR-0151 D2), English model data (species, items, weather labels, the heal cost text) and the
  ASCII colons view code appends outside the catalog (`battleView.ts` `${label}: ${species}`).
- `stripComments` and the test's own literal mask are both blind to regex literals; measured on
  this slice they desync at the same offset and cancel out — a coincidence, not an invariant.
- Spec drift for the supervisor: §4 S7 row / §5.3 vehicle (co-located test), I18N-31/E11 (22).

## Lenses

planner → reviewer ∥ red-team (plan; deltas R1–R8: `${…}` payload is code, `?.(` calls, multi-line
imports, suffixed specifiers, whitespace tolerance, the renamed-`oneOther` limit, two-sentinel
Proxy, CONTENT_VERSION 22) → tester (RED 5 failed / 7 passed at HEAD; the orchestrator ran vitest
for it and corrected two fixture shapes — a one-line union fixture the line-oriented parser needs
multi-line, and a DEAD-KEY fixture whose requested set wrongly held the exempt key) →
red-team-writes-the-cheat on the tests (sandbox) ∥ specialist (`catalog.fr.ts` + `resolver.ts`) →
the `many` reconciliation (D7) → reviewer (French: `box.title` sentence case byte-coupled with its
`battle.swap.hint` echo; `box.hint` "être échangés en cours de combat"; one false BLOCKER — 26
U+00A0 bytes are present) ∥ verifier (12/12 ledger CHECKs reproduced, RED→green integrity clean,
12 named mutants killed, its own mutant surviving → D6). Domain auditors n/a (no server /
game-core surface). Lens outcomes in the PR body and `memory/projects/monster-realm-m24-s7-plan.md`.
