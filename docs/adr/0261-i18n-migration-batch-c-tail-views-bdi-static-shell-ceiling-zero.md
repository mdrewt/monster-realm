# ADR-0261 — Migration batch C: the thirteen tail views and the `index.html` static strings resolve through `t()`/`tf()`, the leaderboard name is `<bdi>`-isolated, `dir="ltr"` lands, and the ceiling ratchets 11 → 0 (M24 S5)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s5 (M24-internationalization S5 — migration batch C, the tail)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0257, 0259, 0260
**Subsystems:** client-ui, ci-gates
**Decision:** The tail views and `index.html`'s view-owned strings resolve through `t()`/`tf()` with semantic keys; the leaderboard name is a `<bdi>` sibling of the catalog text; `dir="ltr"` is the static default; ceiling 11 → 0.

---

## Context

M24 §4 makes S5 the last of the three serial migration batches (`S3 → S4 → S5`). ADR-0259 fixed the
pattern (semantic keys, model data as params, byte-identical English pinned at the catalog layer, a
spy + sentinel routing oracle per view, a per-file zero-failing scanner pin) and ADR-0260 extended it to
constructor-time strings resolved in `show()`. This ADR applies the pattern to the thirteen files the
spec row names, plus the two things only S5 can do: the `<bdi>` wrap at the leaderboard (§2.7,
I18N-20) and `client/index.html`'s static strings (the file is in no other slice's `touches:`).

**Population corrections, measured with the real S2 scanner over comment-stripped source at 10d4109
(the m24-s0/s3/s4 precedent; census in the harness at `memory/projects/m24-s5-scan-census.txt`):**
(1) the spec row's "**45** sinks (E7)" is wrong — the thirteen files hold **55** sinks
(tradeProposeView 7, dialogueView 5, claimView 6, sessionView 4, renameView 4, menuView 4,
leaderboardView 4, helpView 4, errorOverlayView 4, questLogView 2, healView 2, privacyView 7,
evolutionNotice 2), of which **11 FAIL** §2.2 — exactly the whole-tree remainder, so
`HARDCODED_CEILING` moves 11 → **0** here and I18N-19's terminal state is reached in S5, not S6.
(2) ADR-0260's Consequences say "S6 owns `main.ts`'s four and takes the ceiling to its permanent 0";
that was wrong — `main.ts`'s four `chrome.status.*` literals are `reportError('…')` *arguments*, never
sink right-hand sides, so the scanner has never counted them and S6 moves no ratchet. (Recorded here
rather than by amending ADR-0260: an `Amends:` forces a reciprocal header edit for a one-sentence
correction with no decision behind it.)

Five further player-facing literals are scanner-invisible (function arguments and `return` values):
privacyView's `#paintButton(…, 'Close', …)`, `'Confirm deletion'`, `'Keep my account'`, and
evolutionNotice's `Species #${id}` / `${nickname} evolved from ${from} into ${to}!` /
`Your ${from} evolved into ${to}!`. They migrate with zero ratchet effect; the per-view sentinel test is
their only mechanical proof (ADR-0259 R4 class). sessionView, renameView, menuView and helpView carry
zero failing sinks — every sink there is model data or a glyph-only compound (`${c.key} — ${c.action}`,
`${row.keyGlyph} — ${row.title}`), which §2.2 passes and tier (e) keeps as a reorderability residual.

## Considered alternatives

1. **One shared key for the coincident English `'Privacy & Account Data'`** (claimView's button and
   privacyView's heading). Rejected: keys are semantic, not source-derived (§2.3, B5's `"Open"`
   argument) — a locale may want a verb on the button and a noun on the heading. Two keys,
   `claim.privacyButton` and `privacy.title`; the routing tests pin each site's exact key, so a
   cross-alias is red even though the bytes coincide today.
2. **The leaderboard name as a `tf()` parameter** (`tf('leaderboard.row', {name, rating, wins,
   losses})`). Rejected: I18N-21 forbids routing a display name through a catalog value, and §2.7
   requires the name inside a `<bdi>` built with `createElement('bdi')` + `textContent`. Chosen: the
   `<li>` becomes `[<bdi>name</bdi>, textNode]` where the text node is the ONE ★ key
   `leaderboard.row` = `` ` — ${rating} (W${wins}/L${losses})` `` (leading space in the key, the
   `shop.*.row` trailing-space precedent). `li.textContent` is byte-identical to the pre-migration
   string; `replaceChildren(name, tf(…))` stays a scanner-visible sink whose arguments are an
   identifier and an exempt call. Also rejected: a placeholder-splitting post-process (DOM surgery on
   catalog output) and a separate glyph-only "dash" key.
3. **Keep the three view-owned `index.html` literals as a pre-JS fallback** and overwrite them in
   `show()`. Rejected: two sources of truth for one string, and the shells are `display:none` until
   JS shows them, so nothing can read the fallback. The literals are removed; `HelpView`,
   `RenameView` and `TradeProposeView` write `t('chrome.help.title')`, `t('chrome.rename.submit')`
   and `t('chrome.tradePropose.submit')` in `show()`. `#help-hint` (`chrome.helpHint`) is the
   exception and STAYS static: `indexShell.test.ts` parses the raw HTML for its `?` text and
   `main.wiring.test.ts`'s W-UX1-HINT-NO-JS-OWNER forbids `main.ts` from naming the element
   (ADR-0151 D2), so no slice can own a resolver write for it without amending that decision.
4. **Resolve constant strings in the constructor** (red-team's first-cut for the anchor labels).
   Rejected: S6 negotiates the locale at boot, possibly after the views are constructed, so a
   constructor-time `t()` may resolve in the wrong locale. Chosen rule, replacing ADR-0260 D4's
   `show()`-only sentence: **a constant string is resolved in EVERY method that can make it
   visible, unconditionally (never `!wasVisible`-gated), never in the constructor, and never
   inside a `try` a hostile view-model can abort.** Consequences per file are D4 below.
5. **Append the new tests to the existing sibling test files** (the S3/S4 vehicle). Rejected for
   this slice: eleven views means eleven top-of-file `vi.mock` + bottom `describe` splices under the
   tester write guard, into files that other evals pin by needle. Chosen: one new co-located
   `<view>.i18n.test.ts` per migrated view plus `indexShell.i18n.test.ts` — auto-discovered by
   `vite.config.ts`'s `src/**/*.test.ts`, excluded by every `.test.ts` filter the evals use, and each
   a sibling companion of a declared file.

## Decision outcome

- **D1 Scope and bytes.** 11 failing sinks + 5 hoisted literals → 16 new keys (112 total) across
  `tradePropose.*`, `dialogue.*`, `claim.*`, `leaderboard.*`, `errorOverlay.*`, `questLog.*`,
  `heal.*`, `privacy.*`, `evolutionNotice.*`; three existing `chrome.*` keys gain their first call
  sites. Every English value is transcribed from the pre-migration bytes — `…` U+2026 in the target
  placeholder, `·` U+00B7 in the error footer, `—` U+2014 and the LEADING space in `leaderboard.row`.
  `catalog.test.ts` pins every value for two sample-param sets differing in every field.
- **D2 Two keys for one English string** (alternative 1).
- **D3 The `<bdi>` row** (alternative 2). The `<bdi>` carries zero attributes and zero element
  children; the name is never an argument to any resolver call (pinned by LB-01's inspection of every
  `tf` call). `<bdi>` appears nowhere else in this slice: questLog names are content ids and the
  evolutionNotice nickname is plain interpolation, as `pvp.incoming.label` already is.
- **D4 Where each constant resolves** (alternative 4). HelpView / RenameView / TradeProposeView:
  `show()` (the only door). privacyView: `privacy.title` + `privacy.close` in `show()` (the only
  door — `render()` never opens the overlay); `privacy.confirm.delete` / `.keep` in `render()`. The
  close anchor's `display = ''` / `disabled = false` stay in the constructor so the never-disabled
  anchor invariant holds before the first `show()`. claimView: `claim.privacyButton` in BOTH
  `render()` (which opens the overlay via `vm.visible`) and `show()` — two doors, two one-line writes,
  one key; `main.ts`'s `onSignInFailed` calls `show()` before `renderClaim()`, which is the production
  path that needs the second door. errorOverlayView: `errorOverlay.footer` in `show()`, outside
  `render()`'s hostile-VM `try` — the constructor twin and the render-site write are both deleted (the
  file goes 4 → 3 sinks); a first `render()` whose `rows` getter throws can no longer leave the footer
  blank forever. evolutionNotice: `evolutionNotice.ok` in `render(label)` (its only door).
- **D5 Model data are params** with model types (all `number`/`string` here): the quest id and step,
  `formatHealCostLine`'s text, the species/nickname names. Nothing in `*Model.ts`, `privacyBanner.ts`,
  `helpModel.ts` or `a11yCopy.ts` is touched.
- **D6 `index.html`.** `<html lang="en" dir="ltr">` (§2.7's static default; I18N-23's static half —
  S6 writes `documentElement.dir` at boot). After the three removals the only non-whitespace text node
  under `<body>` is `#help-hint`'s, byte-equal to `CATALOG_EN['chrome.helpHint']` (pinned by IX-02).
- **D7 Proof shape** (ADR-0260 D6 + the door rule). Per view `-01` routing (spy; pre-show/pre-render
  text `''` and no call for the key; each door alone resolves it; a repeat `show()`/`render()` after
  `mockClear()` re-requests it), `-02` sentinel (construct before stubbing; whole-subtree walk incl.
  `<option>`; containment pin for every migrated surface incl. the five hoisted literals; roster-word
  absence; post-restore control), `-03` per-file scan pin. **EN-02's nested-sentinel rule:** a string
  that passed through `evolutionNoticeLabel` / `speciesLabel` under the mocked resolver is asserted
  ONLY by exact string equality on the return value, never through `SplitSentinels`/`WalkSubtree`
  (the first-`»` matcher truncates a nested span into a false forged-span); the banner-DOM walk is fed
  a synthetic non-nested label.

## Consequences

- `HARDCODED_CEILING` 11 → **0**: I18N-19 is met; the ratchet is now a zero-tolerance gate for every
  future sink in the non-test client tree.
- `catalog.test.ts`'s exact roster grows 96 → 112; S7's parity eval inherits a complete English catalog.
- `chrome.helpHint` has a catalog entry and zero call sites (D6/alternative 3). S7's DEAD-KEY gate
  must either exempt it or S6 must own a resolver write under an amended ADR-0151 D2 — recorded here
  as the one key this milestone cannot route without a decision it does not own.
- Residual, shared infrastructure, NOT fixed here (R-m24-s4-RT1, `hardcodedStrings.ts` outside
  `touches:`): `this.#t('raw English')` scans as an exempt call because `exemptCallOpenAt` rejects only
  a `.` or identifier character before `t`/`tf`. For this slice's thirteen files it is closed by the
  `-01` exact-key spy pins on the real imported resolver (a private `#t` never reaches it).
- Residuals carried unchanged (outside `touches:`, scanner-invisible, tier (e) / S7 checklist): the
  model-produced copy in `claimModel.ts`, `sessionModel.ts`, `privacyBanner.ts`, `helpModel.ts`,
  `menuModel.ts`, `healModel.ts` (`Free`, `gold`), `dialogueContent.ts`; `a11yCopy.ts` duplicates
  `'Controls & Goals'` and `'Privacy & Account Data'` as accessible names (ADR-0256 D4 follow-up);
  claimView's five sibling buttons still ship blank (pre-existing, tracked follow-up); the glyph-only
  compound rows in helpView/menuView/errorOverlayView stay unkeyed.
- `t(cond ? 'a' : 'b')` and a pass-through local `t` wrapper remain review-banned until S7's
  DYNAMIC-KEY gate makes the ban mechanical.

## Lenses

planner → reviewer ∥ red-team ∥ /simplify (plan; red-team MAJOR-1/-2 produced alternative 4's door
rule) → tester ×2 (disjoint files, RED) → reviewer ∥ red-team (tests) → specialist → reviewer(+/simplify)
∥ verifier → doc-keeper. Domain auditors n/a (no server / game-core surface). Lens outcomes are recorded
in the PR body and the harness plan file `memory/projects/monster-realm-m24-s5-plan.md`.
