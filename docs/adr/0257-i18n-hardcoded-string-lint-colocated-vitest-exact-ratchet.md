# ADR-0257 — The hardcoded-string extraction lint ships as a co-located vitest test with an exactly-pinned migration ceiling, not as `evals/i18n-hardcoded-strings.eval.mjs` (M24 S2)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s2 (M24-internationalization S2 — the extraction lint)
**Supersedes:** —
**Amends:** —
**Extends:** 0224, 0255, 0256
**Subsystems:** client-ui, ci-gates
**Decision:** §5.2's default-fail character-inversion lint is a pure typed scanner (`hardcodedStrings.ts`) driven by a co-located vitest test over the whole non-test client tree, with `SINK_FLOOR = 169` and `HARDCODED_CEILING` pinned exactly to a plain-data baseline.

---

## Context

M24's spec (`specs/monster-realm-v2/M24-internationalization.spec.md`, ceremony 2026-08-23) resolves its
finding F2 — every candidate's "alphabetic run ≥ N" heuristic is self-refuting against `Lv` (E3) and
`W`/`L` (E4) — with §2.2's **default-fail character inversion**: a sink's static text is CLEAN iff every
character is in the closed set `NON_TRANSLATABLE_CHARS`; any other character fails the sink; there is no
length threshold. §5.2 specifies that rule as `evals/i18n-hardcoded-strings.eval.mjs` with five tags
(`[I18N-HC-01..05]`), four BAD and three GOOD fixtures drawn from real lines, and three named vacuity
attacks. §6 restates it as I18N-12..18.

ADR-0224 (2026-09-01, after the ceremony) retires new `evals/*.eval.mjs` files outright; ADR-0255
(m24-s0) and ADR-0256 (m24-s1) already delivered their gates as ordinary co-located vitest tests. The
operator directive for this slice (2026-09-01, ADR-0224 "Work-selection scope") makes the same
substitution mandatory here and holds **everything else** in §5.2 unchanged — including `SINK_FLOOR`,
`HARDCODED_CEILING` and the three vacuity proofs.

Measured at HEAD (66041fc) before this slice: the E7 grep over the 19 spec-named files yields **174**
sinks (S0 converted its 13 `innerHTML` sites 1:1 into `textContent`/`replaceChildren`, so E5's 169 is
still a floor, not an equality); zero `setAttribute` first arguments are allowlisted (E7 said so —
the allowlist branch is fixture-proven only); and two production files that write player-facing text
exist **outside** the spec's 19: `ui/privacyView.ts` (rb-53, 7 sinks, `:145` `'Privacy & Account Data'`)
and `ui/evolutionNotice.ts` (ADR-0254, `:209` `'OK'`). E6's roster is simply older than the tree.

## Considered alternatives

- **The spec's `evals/i18n-hardcoded-strings.eval.mjs`** — rejected: ADR-0224 bans it; the operator
  directive is explicit.
- **An AST-based scan (TS compiler API)** — ADR-0224's escape hatch for whole-codebase scans. Rejected:
  the sink vocabulary is four tokens, the classification is per-character, and the only parsing the rule
  needs is "where does a literal start and end", for which the repo's proven `stringMask` cursor exists.
  ~150 lines of typed `indexOf`/char loops beat a compiler-API dependency for this shape.
- **Importing `stringMask` from `evals/client-no-pii-logs.eval.mjs`** — rejected on tooling grounds:
  the helper is a non-test `.ts` under `client/src/` and is typechecked by `client-typecheck` (strict,
  no `allowJs`), so a `.mjs` import is TS7016. The test file (untypechecked) DOES import the single-owner
  `stripComments` (ADR-0215 scope: the comment stripper, not the literal mask). The literal mask is a
  minimal typed port with its origin cited in-file (`client-no-pii-logs.eval.mjs:166-249`).
- **A `≤`-only ceiling** (the spec's HC-04 letter) — rejected as the sole assertion: under the vitest
  vehicle the gate cannot use the spec's "expected RED at HEAD" proof (§4.1, B4) — a red test blocks
  merge — and with `≤` alone a scanner that stops seeing literals reports `0 ≤ N` and is green on
  nothing. The exact pin restores the proof that the gate sees the tree.
- **A hand-kept 19-file roster as the only scope** — rejected: it would ratchet the wrong roster
  (`privacyView.ts`, `evolutionNotice.ts` already outside it) and every new `*View.ts` would be a
  silent gap. The S0 precedent (ADR-0255 D2) scans the whole non-test tree at no cost.

## Decision outcome

- **D1 — Vehicle.** `client/src/ui/i18n/hardcodedStrings.test.ts` (vitest, discovered by
  `src/**/*.test.ts`, run by `just ci`'s client stage) over the pure helper
  `client/src/ui/i18n/hardcodedStrings.ts`. Phase 0 (fixtures) runs before any real file is read; the
  real scan is memoised and read once.
- **D2 — Scope.** Every non-test `client/src/**/*.ts` (walk + `endsWith('.test.ts')`). The 19
  spec-named files (`main.ts` + 18 `ui/*View.ts`) are asserted **present and non-empty after
  stripping**, a missing one is a hard fail (I18N-HC-05). `SINK_FLOOR = 169` applies as `≥` to the
  whole-tree total (I18N-HC-03).
- **D3 — The rule, exactly §2.2**, with one deliberate strengthening: **every** string/template
  literal inside a sink's right-hand side — at any paren or `${}` nesting depth — contributes its static
  segments, not only the depth-0 template's text. §2.2 examines "the text outside every `${}`";
  examining interpolation contents too is strictly stricter in the direction §2.2 itself names as
  correct ("the failure direction is toward extraction") and kills two smuggling shapes the plan
  red-team measured: `replaceChildren(emptyRow('Nothing for sale.'))` (`shopView.ts:125/136/144`, three
  real player-facing strings that a depth-0 reading would pass) and `` `${c ? 'Won' : 'Lost'}` ``.
  The only exemption is a `t(`/`tf(` **call span** (identifier-boundary before the name, no `.` receiver,
  balanced parens skipped through the mask); everything inside it is inert. This generalises §5.2's "the
  RHS is a `t(`/`tf(` call" so that `` `${t('a')} · ${t('b')}` `` and `t('x') + ' ' + n` pass while
  `t('x') || 'Fallback'` and `obj.t('Raw')` fail. Zero literals ⇒ PASS (bare identifiers, property
  access, `String(n)`, `''`, `replaceChildren()`). The closed set is the literal 33-member `Set` in
  the helper (4 ASCII whitespace ∪ 10 digits ∪ the 19 glyphs of §2.2); it grows only by reviewed PR.
- **D4 — Sink vocabulary (I18N-HC-02).** `.textContent =`/`+=`, `.title =`/`+=`, `replaceChildren(`,
  and `setAttribute(` whose **first** argument is a bare quoted literal in
  `{aria-label, aria-live, aria-describedby, title, alt}` — checked before any RHS character is read.
  `==`/`===` are reads; `.titleEl`/`.title(` are other members; `.id =`, `.className =`,
  `.style.cssText =`, `.dataset.*`, `addEventListener(` are structurally absent (asserted in the
  test). `.innerHTML` is not in S2's vocabulary: S0's gate bans it tree-wide, and the token must not
  appear adjacent to `=` in any non-test file.
- **D5 — The ceiling, and the tension with ADR-0224 named honestly.** The baseline is plain data,
  `client/src/ui/i18n/__fixtures__/i18n-hardcoded.json` `{"HARDCODED_CEILING": N}`, with no update
  flag; the test asserts `failing ≤ N` (I18N-18's letter) **and** `failing === N`, plus `N` is a
  non-negative integer `≤ sinks` and `N ≤ CEILING_AT_S2` (a constant in the test, so raising the
  ceiling above the S2 mark requires editing a test, not a JSON). ADR-0224's amendment retires
  "numeric floors/ratchets whose entire purpose is checking another check". `HARDCODED_CEILING` is not
  that: it is the **migration ledger** I18N-19 drives to 0 across S3–S6 (43 + 77 + 45 + 4 sinks, E7),
  and it protects a shipping outcome — every player-facing string reaches the catalog — not another
  test's existence. `SINK_FLOOR` is the denominator proof for that ledger and becomes inert once the
  ceiling is 0. Both are kept by operator directive; this ADR records that as a scoped exception, not
  a reversal of ADR-0224. **Merge discipline:** S3→S4→S5 are serial by spec; `S6 ‖ S3` is a declared
  pair and both lower the count, so the second to merge re-measures and edits the JSON (one line, the
  failure message says which). The `touches:` of S3/S4/S5/S6 now include the JSON.
- **D6 — Fail-loud tripwires.** `unterminated` (mask ends inside a literal) fails the file; a sink
  token found at a masked index fails loud (the parity-flip signature of two regex literals each holding
  one quote, which leaves `unterminated` false); an RHS that hits EOF at bracket depth > 0 is
  `truncated` and fails the real scan.
- **D7 — Spec reconciliation.** §4's S2 row, §5.2's heading, HC-04's baseline path and the §5 intro
  record the vehicle; S5's `touches:` gains `privacyView.ts` + `evolutionNotice.ts` (else I18N-19's
  ceiling = 0 is unreachable); S3/S4/S5/S6 gain the JSON.

## Consequences

- Positive: F2 is closed by a rule with no heuristic axis; the three vacuity attacks are fixture-proven
  through the same `scanSource` the real scan uses; the ceiling makes every migration slice's progress
  a reviewed one-line diff; two post-spec files are inside the scope instead of silently outside it.
- Negative / accepted residuals (tier (e), §5.6 manual checklist — the lint cannot see them):
  - **Hoisted identifiers and parameters.** A bare identifier RHS passes by design (HC-01). Measured:
    28 identifier-RHS sinks in the 19 files and ~41 off-sink prose literals (`showFeedback('…')` ×16,
    `reportError('…')` ×5, `#actionLabel` returns ×5, outcome texts ×3, compass names ×8), plus the
    bulk of player prose born in `ui/*Model.ts`, `dialogueContent.ts`, `a11yCopy.ts`,
    `announcements.ts`. S3–S6 own those by file roster, not by lint.
  - **Out-of-vocabulary sinks** (all zero today): `.innerText =`, `insertAdjacentText(`,
    `append('…')`, `new Text('…')`, `createTextNode('…')`, `.placeholder =`, `.value =`,
    `document.title =`, `el['textContent'] =`, `Object.assign(el, {textContent})`, and
    `prompt(`/`alert(`/`confirm(` (`boxView.ts:248` is a live `prompt('New nickname:', …)`).
  - A non-literal `setAttribute` first argument (`setAttribute(ARIA_LABEL, v)`) is not a sink.
  - Whitespace is ASCII-only (`U+00A0`, en dash `U+2013` are NOT in the set); `…`, `’`, `✓`, `★`,
    `→`, `•` are not in the set — `` `→ ${name}` `` (`evolutionView.ts:242`) keeps failing after
    migration unless `→` is reviewed in. A backslash escape (`'\n'`) fails. All fail toward extraction.
  - `t('Raw prose')` passes the lint and fails `tsc` via the `MessageId` union — the exemption leans
    on the type system (ADR-0256).
- Follow-up: none scheduled. The ceiling reaches 0 at S6 and the exact pin becomes a permanent
  0-ratchet with no further edits.
