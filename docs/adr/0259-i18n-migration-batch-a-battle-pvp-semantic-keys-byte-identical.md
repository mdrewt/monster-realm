# ADR-0259 — Migration batch A: `battleView.ts` and `pvpView.ts` resolve every player-facing string through `t()`/`tf()` with semantic keys, byte-identical English, and the ceiling ratchets 81 → 57 (M24 S3)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s3 (M24-internationalization S3 — migration batch A, the two densest views)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0257
**Subsystems:** client-ui, ci-gates
**Decision:** The two densest views call `t()`/`tf()` from the ONE flat catalog with semantic `battle.*`/`pvp.*` keys; English output is byte-identical; 24 failing sinks + 5 scanner-invisible hoisted literals migrate; `HARDCODED_CEILING` 81 → 57.

---

## Context

M24 §4 makes S3 the first of three serial migration batches (`S3 → S4 → S5`): migrate the two densest
views to the resolver ADR-0256 shipped, add their `MessageId` members and `catalog.en.ts` entries to the
single flat union/catalog (§2.3 — no per-view shards; that single-union decision is *why* the batches
are serial), and lower the S2 lint's exactly-pinned `HARDCODED_CEILING` (ADR-0257 D5) by the migrated
count. The spec row counts "**43** sinks (26 + 17, E7)".

**Population correction, measured with the real S2 scanner over comment-stripped source at ec3482a
(the m24-s0 "13 not 14" precedent):** `battleView.ts` has **25** sinks (the spec's 26), of which **16
FAIL** §2.2's rule; `pvpView.ts` has **17** sinks, of which **8 FAIL**. The E7 "43" is the TOTAL-sink
count; the ratchet counts FAILING sinks (ADR-0257 D5 measured 81 failing of 182 tree-wide), so this
slice moves the ceiling by **24**, to **57**, not by 43. The remaining 18 sinks in the two files are
already clean — `''` clears, `replaceChildren()`, bare-identifier RHS (`card.status`, `p.name`, `msg`,
`text`), and two glyph-only compound rows (`${label}: ${species}`, `${bait.name} (+${n}‰) ×${c}`) that
§2.2 itself names as the honest tier-(e) reorderability residual.

Five more player-facing literals in `battleView.ts` are **structurally invisible to the scanner** — not
a scanner bug, the rule's own "zero segments ⇒ PASS": `'You'` and the `'Opponent'` fallback are passed as
a plain *argument* to `#renderMonsterCard(el, card, label)` (`:289-291`), and `'Victory!'` /
`'Defeat...'` / `'Got away safely!'` are assigned to a local `text` whose bare identifier is the sink RHS
(`:626-646`). A correct migration of these five leaves the scanner's verdict unchanged and moves no
ratchet.

Constraints the migration inherits: a 68-test `battleView.test.ts`, `pvpView.test.ts`,
`main.wiring.test.ts`, `store.test.ts` and the e2e specs pin the current English bytes (`'Victory!'`,
`/^Submit: /`, `button:has-text("(")`, `'No bait'`, `'Press Esc to continue'`, …); ADR-0256 D5's key
grammar and §2.3's semantic taxonomy; every catalog entry needs an adjacent `// @desc:` line
(`catalog.test.ts` SHAPE-01); `catalog.test.ts` CATALOG-SHAPE pins the exact key roster and invokes
every closure with `{ where: 'x' }`.

## Considered alternatives

- **Migrate only the 24 scanner-visible sinks** (the ratchet's letter). Rejected: a "migrated view"
  whose outcome banner and card labels stay English in every locale is a lie the lint cannot see; the
  five hoisted literals are exactly the ADR-0257 tier-(e) residual class S3–S6 own *by file roster*.
- **Key the glyph-only compound rows too** (`${label}: ${species}`, the bait option). Rejected for
  S3: they move no ratchet, §2.2 classifies them as a manual-checklist residual, and keying them now
  widens the diff without a gate that can tell right from wrong. Named as an S7 risk (French ` : `
  spacing) instead.
- **Fix the `(${n} turns)` plural while here.** Rejected: "1 turns" is a pre-existing English defect;
  fixing it is a reword, which §2.3 says takes a FRESH key (and the first `oneOther` use) — its own
  change, not a migration side-effect.
- **A dynamic key for the outcome banner** (`t(\`battle.outcome.${tag}\`)` or a tag→key map). Rejected:
  S7's `[I18N-27] DYNAMIC-KEY` gate reds any non-literal first argument; the exhaustive `switch` keeps
  three literal `t()` calls and its `never` arm.
- **A view-local `label()` wrapper over `t()`.** Rejected: the scanner's exemption is the bare
  `t(`/`tf(` call span only — a wrapper's literals would FAIL the lint, and S7's `DEAD-KEY`/`DYNAMIC-KEY`
  scans read `t(`/`tf(` call sites.
- **Keep the three constructor-time strings where they are.** `battle.title`, `battle.swap.hint`,
  `battle.continueHint` are written once in the constructor today and never rewritten by
  `show()`/`refresh()`. Rejected: resolving at construction freezes English unless S6 calls
  `setLocale` before `main.ts` constructs the view (`main.ts:2531`, deep inside the async connect
  path) — an unenforced cross-file ordering invariant. They resolve in `show()` instead (idempotent,
  the same per-render pattern as the other 21 sinks).
- **Prove routing by string equality alone.** Rejected: a site that calls `t()` and ALSO assigns the
  literal is green under equality; the test suite instead stubs the resolver to `«key»` sentinels and
  asserts the DOM shows the sentinel (see D6).

## Decision outcome

- **D1 — Scope = 24 failing sinks + 5 hoisted literals; byte-identical English.** Every catalog value
  reproduces today's bytes, including `’` (U+2019) and `…` (U+2026) in `battle.pvp.waiting` and
  `pvp.outgoing.label`. The two-part `+`-concatenated swap hint becomes ONE catalog string.
- **D2 — Key taxonomy `<namespace>.<screen>.<element>`** (§2.3), ADR-0256 D5 grammar, semantic never
  source-derived: `battle.title`, `battle.continueHint`, `battle.swap.hint`, `battle.pvp.waiting`,
  `battle.weather.banner`★, `battle.card.you`, `battle.card.opponent`, `battle.card.level`★,
  `battle.card.hpLine`★, `battle.skill.pvpSubmit`★, `battle.skill.pveLabel`★, `battle.skill.accuracy`★
  (the `.title` tooltip — named for the content, not the DOM attribute), `battle.action.flee`,
  `battle.recruit.noBait`, `battle.recruit.submit`, `battle.cure.placeholder`, `battle.cure.option`★,
  `battle.cure.submit`, `battle.swap.pvpSubmit`★, `battle.swap.pveLabel`★, `battle.outcome.victory`,
  `battle.outcome.defeat`, `battle.outcome.fled`; `pvp.title.idle`, `pvp.title.challenge`,
  `pvp.incoming.label`★, `pvp.incoming.accept`, `pvp.incoming.decline`, `pvp.outgoing.label`★,
  `pvp.outgoing.cancel`, `pvp.players.none`, `pvp.players.heading`. 32 new keys (42 total), 11 new
  `MessageParams` rows (★). Every `t(`/`tf(` first argument is a string literal; ternaries are
  `cond ? tf('a', …) : tf('b', …)`, never `t(cond ? 'a' : 'b')`.
- **D3 — Model data are params, never catalog text** (§2.5: content stays English this milestone):
  `affinity`, `w.label`, `card.status`, `cureStatus`, species/skill/item names and player display names
  flow through `${}` interpolation only — `pvp.incoming.label` / `pvp.outgoing.label` are the I18N-21
  pure-interpolation shape for `challengerName`/`targetName`; `pvpOpponentName`, when set, is passed
  through raw (no key requested).
- **D4 — No resolver change, no shard, no wrapper, no `main.ts` edit.** `tf`'s single narrowing cast
  (ADR-0256) absorbs the 12-entry `MessageParams` table (PoC'd through `tsc`: clean, and a wrong param
  type is TS2322). `pvpView.showFeedback(msg)` renders text owned by `main.ts` — S6's.
- **D5 — Ratchet.** `__fixtures__/i18n-hardcoded.json` `81 → 57`; the S2 test's `===` pin is the proof
  the scanner still sees the tree (ADR-0257 D5). `S6 ‖ S3` may both lower it — the second to merge
  re-measures (one-line edit).
- **D6 — The routing oracle is spy + sentinel, in the view tests.** `vi.mock('./i18n/resolver',
  { spy: true })` (the `./overlayA11y` precedent) asserts the exact key + params per site; a second pass
  stubs `t`/`tf` to `«key»` sentinels over an EXPLICIT view-model matrix that renders every
  conditional branch (the three terminal outcomes, PvP with `pvpOpponentName` unset and set,
  pending-submit on/off, weather, bench, bait, cure items; pvp idle/incoming/outgoing/player-list) and
  walks the whole `#root` subtree (text, `title` attributes, `<option>` text) asserting the sentinels
  are present and none of the English roster words is — the DOM value must BE the resolver's return
  value. The five hoisted literals have NO other mechanical proof; this matrix is it. A per-file
  `scanSource` pin in each view test asserts `failing.length === 0` exactly with the sink total as a
  `>=` floor (the `SINK_FLOOR` idiom — an unrelated clean sink added later must not red an i18n gate).
- **D7 — Catalog-layer teeth.** `catalog.test.ts` grows a `SAMPLE_PARAMS` table with TWO sample sets
  per ★ key differing in EVERY field (numbers included) and pins the exact output for both — a closure
  that ignores a numeric-only param (`() => 'Acc 50%'`) dies; 14 of the 29 migrated strings have no
  other byte-identity dependent, so the expected bytes are transcribed by the TESTER from the
  pre-migration source before the catalog exists.

## Consequences

- Positive: the two densest views are locale-ready; 32 semantic keys with translator `@desc` notes; the
  ratchet moves fastest first (§4: descending density); the hoisted-literal class has a proven test shape
  (sentinel matrix) S4/S5 can reuse for their own `*Model`-adjacent literals.
- Negative / accepted residuals:
  - The two glyph-only compound rows (`${label}: ${species}`, bait option) stay unkeyed — a locale
    needing `${species} : ${label}` or `×${count} (+${n}‰)` cannot be served; S7's reviewer must know
    (tier (e), §5.6 manual checklist).
  - `(${turns} turns)` keeps its English plural defect ("1 turns") — a reword needs a fresh key.
  - `battle.skill.accuracy` is a `title` tooltip: invisible to touch/AT (pre-existing,
    R-m23-s8-postmerge-title); migrating it does not fix that.
  - `battle.card.you`/`battle.card.opponent` and the outcome keys move no ratchet; a future slice that
    re-hardcodes them is caught only by the sentinel matrix.
- Follow-ups: none scheduled here; S4 (batch B) is next in the serial spine.

## Lenses

planner → reviewer(+/simplify) ∥ red-team (plan; the sentinel matrix, the `>=` sink floor, the
`show()`-time resolution and the output-equality catalog pins came from these) → tester → red-team
(tests) → specialist → reviewer ∥ verifier → doc-keeper; domain auditors not applicable (no
server/game-core surface).
