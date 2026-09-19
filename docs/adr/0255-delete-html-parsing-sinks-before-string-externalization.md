# ADR-0255 — Delete the client's HTML-parsing sinks before any string is externalized (M24 S0)

**Status:** Accepted
**Date:** 2026-09-19
**Slice:** m24-s0 (M24-internationalization)
**Supersedes:** —
**Amends:** —
**Extends:** 0224
**Subsystems:** client-ui, ci-gates
**Decision:** The 13 live `innerHTML =` sites (3 markup, 10 clears) become `createElement`+`textContent` / `replaceChildren()`, and a co-located vitest test pins zero HTML-parsing sinks across the whole non-test client tree, matched on the sink alone.

## Context

M24 (harness spec `M24-internationalization.spec.md`, design authority harness ADR-0033) will move the
client's chrome strings into a catalog whose values will eventually be authored outside the team (the
§2.6 importer). The spec's central finding (F1, §2.1) is that **no gate that classifies the right-hand
side of an assignment can protect that path**: `list.innerHTML = t('shop.empty')` passes every
"did the call site use `t()`?" check and still parses the catalog value as HTML. The only closure is to
have no HTML-parsing sink for a catalog value to reach.

At HEAD the discipline "never `innerHTML` with data" lived in nine source comments and one unit test
(`leaderboardView.test.ts` `RL13-xss`) with **no mechanical oracle** (spec finding 11-C). The live sink
population, re-measured in this slice, is **13 sites, not the spec's 14**: the spec's
`dialogueView.ts:30` clear had already been converted to `replaceChildren()` by m23-s3
(`dialogueView.ts:59`). The 13 are all `.innerHTML =` assignments — 3 assign literal `<li>` markup
(`shopView.ts`) and 10 assign `''` as a clear idiom (`shopView.ts` ×3, `tradeView.ts` ×5,
`questLogView.ts`, `healView.ts`). Zero `outerHTML =`, `insertAdjacentHTML(`, `document.write(` or
`.setHTML(` sites exist.

The spec's own S0 `touches:` names a **new `evals/i18n-no-html-sink.eval.mjs`**. ADR-0224 (2026-09-01,
which postdates the spec's 2026-08-23 ceremony) retires new `evals/*.eval.mjs` files outright and
requires new mechanically-checkable invariants to be ordinary co-located tests.

## Considered alternatives

- **Guard the sink with an RHS predicate** (allow `innerHTML =` when the RHS is a literal / not a
  catalog call). Rejected — this is exactly the class F1 proves cannot be trusted; a predicate on the
  RHS is what an extraction-lint slice would later have to special-case, and every special case is a
  hole a catalog value can walk through.
- **Keep the ten `innerHTML = ''` clears and exempt the empty RHS.** Rejected — an exemption IS an RHS
  predicate. The check is only RHS-independent when its vocabulary has zero exceptions; converting the
  clears is what buys that (spec §2.1(a)). `replaceChildren()` with no arguments is the standard,
  parse-free equivalent and is already the idiom in `dialogueView.ts` and `liveRegion.ts`.
- **`evals/i18n-no-html-sink.eval.mjs` as the spec names it.** Rejected by ADR-0224 — no new eval
  scripts. The identical invariant ships as `client/src/ui/i18n-no-html-sink.test.ts`, discovered by
  vitest's `src/**/*.test.ts` include and run by `just ci`'s client stage. It imports the single-owner
  `stripComments` from `evals/dom-shell-coverage-exclusion.eval.mjs` (ADR-0215: no third stripper)
  rather than re-declaring one.
- **A TS-compiler-API (AST) scan.** Rejected as YAGNI — a five-token vocabulary over comment-stripped
  text with a measurably zero population needs no parse tree; ADR-0224 reserves AST scans for genuine
  whole-codebase censuses with no single assertion target.
- **Scope the scan to the five declared S0 files only.** Rejected — the whole non-test client tree is
  sink-free after S0, so the stronger invariant is satisfiable at no cost, and a five-file scope would
  let a sixth file reintroduce a sink silently.

## Decision outcome

- **D1 — Conversion.** The 3 markup sites use a module-private `emptyRow(text)` helper
  (`createElement('li')` + `textContent`) and `replaceChildren(li)`; the 10 clears become
  `replaceChildren()`. No exported symbol is added or renamed. The M23 overlay-a11y wiring
  (`openOverlayA11y`/`closeOverlayA11y` calls, and the "paint first, then claim" statement order in
  `questLogView.ts`/`healView.ts`) is preserved byte-for-byte.
- **D2 — Scope.** The test scans every `client/src/**/*.ts` file whose name does not end in
  `.test.ts` (`endsWith`, never substring), including `module_bindings/`.
- **D3 — Matcher.** `String.indexOf` loops only (no `RegExp` — the ReDoS / `detect-non-literal-regexp`
  ban). Assignment family: `.innerHTML` / `.outerHTML` followed by optional whitespace **including
  newlines**, then `=` not followed by `=`, or `+=`. Comparisons (`==`, `===`) are getter reads and do
  not count — the spec's "the matcher requires the `=` token" rule. Call family: the literal tokens
  `insertAdjacentHTML(`, `document.write(`, `.setHTML(`.
- **D4 — Anti-vacuity is on files READ, never on sites matched.** The site population legitimately
  reaches zero, so a site floor (the spec's earlier `SINK_FLOOR = 169` draft, corrected in §2.1) is
  unsatisfiable by construction. The test instead pins a **named roster**: the five S0 view files,
  `main.ts`, and one canary file per other top-level `client/src` subdirectory, each present and
  non-empty after stripping. There is no numeric file-count floor (ADR-0224 amendment: no ratchets).
  The spec's I18N-4 wording "all 19 in-scope files" is S2's extraction-lint scope (13 text-bearing
  `DOM_SHELLS` + 6 omitted views) and does not bound S0's scan, which is the whole tree.
- **D5 — I18N-5 oracle.** `ShopView.render(no-shop)` after a populated render must make exactly one
  `createElement('li')` call and leave `#shop-for-sale` with one `<li>` holding one Text node, and
  `#shop-inventory` empty. The DOM result of `innerHTML = '<li>x</li>'` and of the element build is
  byte-identical for a constant string, so the `createElement` spy is the direct witness of the spec's
  wording ("built by `createElement`"); the test deliberately does not pin the `textContent` setter
  (`append(text)` / `createTextNode` are equally parse-free) — the source-level absence of `innerHTML`
  is I18N-1's job.
- **D6 — Proof-of-teeth, once.** I18N-3 passes the spec's fixture through the same `findHtmlSinks` the
  scan uses, plus the newline-split and `+=` positives and the comparison / commented-out negatives.
  Per ADR-0224 no follow-up audits this test for blind spots.

## Consequences

- Positive: the XSS firewall the nine comments describe is now mechanically enforced across the whole
  client, before S1 introduces the first catalog value; S2's extraction lint can match on the sink
  alone with no RHS exception.
- Accepted, **declared review-lens items — not gates** (ADR-0224): the vocabulary is the spec's five
  tokens. Bracket access (`el['innerHTML'] = x`), `Object.assign(el, { innerHTML })`, `Reflect.set`,
  `document.writeln(`, `setHTMLUnsafe(`, `DOMParser.parseFromString`, `Range.createContextualFragment`
  are outside it and are the reviewer's / security-auditor's eye at review time.
- Known fragility inherited from the reused stripper: `stripComments` has no regex-literal state, so a
  future regex literal containing an unescaped `'` in the same file as a comment mentioning
  `innerHTML =` would desync it and produce a **spurious** I18N-1 red. Measured 0/166 files affected
  at HEAD. Diagnose such a red by checking the file's regex literals before suspecting a real sink; do
  not grow the stripper (ADR-0224).
- The spec's S0 row still names `evals/i18n-no-html-sink.eval.mjs`; the artifact is the co-located
  test above. Spec text is reconciled by the doc pass, not by this ADR.
