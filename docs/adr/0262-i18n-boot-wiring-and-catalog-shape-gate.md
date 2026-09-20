# ADR-0262 — Boot wiring: the locale is negotiated once at module scope, `lang`/`dir` are written once each, the six `chrome.status.*` literals migrate, and the §5.4 catalog-shape gate ships as a co-located vitest test (M24 S6)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s6 (M24-internationalization S6 — boot wiring + the catalog-shape gate)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0257, 0261
**Subsystems:** client-ui, ci-gates
**Decision:** `main.ts` negotiates the locale once at module scope (`?locale=` values, then `navigator.languages`, against `Object.keys(CATALOGS)`), writes `documentElement.lang`/`dir` once each, resolves its six status strings, and `[I18N-SHAPE-01..06]` is `catalogShape.test.ts`.

---

## Context

M24 §4 gives S6 two deliverables: the boot wiring §2.7 specifies as "exactly two writes … set once at
boot in `main.ts`" (I18N-22), and the §5.4 catalog-shape gate `[I18N-SHAPE-01..06]` (I18N-24, I18N-25,
I18N-33). S1 (ADR-0256) shipped `locale.ts` (`negotiateLocale`, `isRtl`) and `resolver.ts` (`setLocale`,
the module locale cell) with **zero production callers** — both graphs report only their own test files
— so until this slice every view resolved English because nothing had ever called `setLocale`. S5
(ADR-0261 D6) landed the static half of I18N-23 (`<html lang="en" dir="ltr">`) and left two things for
S6 by name: the six `chrome.status.*` keys whose only sites are `reportError('…')` arguments in
`main.ts` (catalog header: "wait for S6"), and the `chrome.helpHint` question (ADR-0261 Consequences:
"S7's DEAD-KEY gate must either exempt it or S6 must own a resolver write under an amended ADR-0151 D2").

Three facts shaped the implementation more than the spec did:

1. **`main.ts` is comment-budget-exhausted.** `main.wiring.test.ts` guards comment-stripped `main.ts`
   at more than half its raw size at ~9 sites (measured margin ≈120 bytes before this slice). Every
   comment byte costs half a byte of margin; every code byte buys half. The hunk therefore carries ONE
   comment line and the rationale lives here.
2. **`main.ts` already imports `t` from `./ui/a11yCopy`**, and its one call site,
   `t('a11y.world.region')`, sits inside the `M23S5-A11YSNAPSHOT` region that
   `main.wiring.test.ts` (W-M23S5-LIVEREGION-PUMP) freezes byte-exactly (ADR-0206 D3). Renaming the
   a11y import would force a re-freeze of another milestone's body pin.
3. **ADR-0224 retires new `evals/*.eval.mjs` files.** The spec names
   `evals/i18n-catalog-shape.eval.mjs`; S0 (ADR-0255) and S2 (ADR-0257 D1) already substituted a
   co-located vitest test for the same reason, and this slice does the same.

The plan was red-teamed before the tests were written and the tests were red-teamed by writing the
cheat against a sandbox; the findings that changed the design are cited inline below.

## Considered alternatives

- **Negotiate inside `main()`** — rejected. Every view is constructed inside `main()`, so a call at
  the top of `main()` is runtime-indistinguishable from module scope on the happy path, but the F-3
  family (ADR-0128, ADR-0157: `resolveConnectionConfig`, `resolveDevLogLevel`, `resolveTelemetryConfig`)
  resolves boot constants at module scope so no `try/catch` inside `main()` can swallow a throw, and
  the source pin (BOOT-05) needs one unambiguous place. The hunk sits after `fateLogger`, before
  `ZONE_ID`.
- **`t as a11yT` for the a11y import, bare `t`/`tf` for i18n** — rejected on fact 2. Instead the i18n
  resolver is imported as `t as i18nT` (and bare `tf`, which a11yCopy does not export). Cost, owned by
  S7: the DEAD-KEY / DYNAMIC-KEY census must resolve local names from each file's `./i18n/resolver`
  import specifiers (or roster `i18nT(`), or the six `chrome.status.*` keys will look dead. The S2
  scanner is unaffected: `reportError(…)` arguments were never sinks (`hardcodedStrings.ts:15-19`), so
  `HARDCODED_CEILING` stays 0 and the JSON baseline is untouched.
- **`URLSearchParams.get('locale')`** — rejected for `getAll('locale')`: no null branch, and a
  multi-value override (`?locale=xx&locale=he`) cascades in URL order. An unknown override falls
  THROUGH to `navigator.languages` and then to `en` (`negotiateLocale`'s own fallback); no
  `console.warn` (§2.7 calls the override a testing aid).
- **Reading `currentLocale()` at the two DOM writes** — rejected by `/simplify`: after
  `setLocale(LOCALE)` the cell IS `LOCALE` by construction, so both writes read the local binding and
  the `currentLocale` import is dropped. The BOOT-05 needle pins that spelling deliberately.
- **Owning a `chrome.helpHint` resolver write in `main.ts`** — rejected. ADR-0151 D2 makes the hint
  static markup and `main.wiring.test.ts` W-UX1-HINT-NO-JS-OWNER is a RAW-source negative pin on the
  token `help-hint` (comments included). Amending ADR-0151 is not this slice's to do.
- **The spec's `[I18N-SHAPE-03]` regex `/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/`** — rejected: it would red
  `chrome.helpHint` and `a11y.overlay.boxView.title` at HEAD. ADR-0256 D5 already corrected the grammar
  to camelCase tails; the gate encodes D5.
- **UTF-16 `.length` or `Intl.Segmenter` graphemes for the width budget** — rejected for code points
  after NFC (`Array.from(v.normalize('NFC')).length`): `.length` double-counts astral characters, and a
  decomposed accent (`e` + U+0301) would be penalised without NFC; graphemes are YAGNI for a 47-char
  hint.
- **Tolerating `/** @desc: */`** — rejected: `catalog.en.ts` uses `//` only and S8's exporter parses
  one form.

## Decision outcome

- **D1 Vehicle.** `client/src/ui/i18n/catalogShape.test.ts` (vitest, discovered by
  `src/**/*.test.ts`, run by `just ci`'s client stage) replaces the spec's
  `evals/i18n-catalog-shape.eval.mjs`, on the ADR-0224 / ADR-0257 D1 template. Checkers live in the
  file (the S0 shape), use `String.indexOf`/char-class loops with zero `RegExp`, and import the
  single-owner `stripComments` (ADR-0215) where comments must be blanked; SHAPE-01 carries its own
  code/comment/string/template state machine because it must READ comment text.
- **D2 The hunk.** At module scope, after `fateLogger`:
  `const LOCALE = negotiateLocale([...new URLSearchParams(window.location.search).getAll('locale'), ...navigator.languages], Object.keys(CATALOGS)); setLocale(LOCALE); document.documentElement.lang = LOCALE; document.documentElement.dir = isRtl(LOCALE) ? 'rtl' : 'ltr';`
  — one comment line. Exactly one write each (I18N-22); `Object.keys(CATALOGS)` so S7's `fr`
  registration wires itself with no `main.ts` edit.
- **D3 Import shape.** `import { CATALOGS, t as i18nT, setLocale, tf } from './ui/i18n/resolver'`
  (biome orders specifiers by LOCAL name — the plan-review red-team measured that the
  alphabetical-by-original-name spelling is rewritten on save) and
  `import { isRtl, negotiateLocale } from './ui/i18n/locale'`. The a11y import and its call site are
  byte-identical to before.
- **D4 The six migrations.** `main.ts` `reportError` sites 582/651/961/1040/2442/2524 resolve
  `chrome.status.exportBlocked` / `privacyOverlayBusy` / `disconnected` (`tf`, `{ where }`) /
  `contentStale` / `bugBundleBlocked` / `healUnavailable`, byte-identical English (pinned by
  `catalog.test.ts`). NOT migrated: the eight `showFeedback('disconnected — try again')` sites and
  `SESSION_`/`CLAIM_DISCONNECTED_FEEDBACK` — no catalog key exists and `messageIds.ts`/`catalog.en.ts`
  are outside this slice's `touches:`.
- **D5 `chrome.helpHint` stays static.** S7's DEAD-KEY gate exempts exactly `{chrome.helpHint}`;
  `[I18N-SHAPE-02]` governs the catalog value and `indexShell.i18n.test.ts` IX-02 keeps the
  `index.html` literal byte-equal to it. Residual: a non-`en` locale shows the English hint until
  ADR-0151 D2 is amended.
- **D6 The gate's shape.** SHAPE-01: `//`-only, line-initial `// @desc:` after trim, ≥10
  non-whitespace characters after the marker on that line, in the contiguous `//` block ending at the
  entry line − 1 (a blank line breaks it), never inside a string/template literal. SHAPE-02:
  `WIDTH_CONSTRAINED_KEYS = { 'chrome.helpHint': 47 }`, non-empty, every key `Object.hasOwn` in EVERY
  registered catalog (hard fail — the vacuity attack), `<=` on NFC code points; the `en` value measures
  exactly 38. SHAPE-03: ADR-0256 D5 grammar, a belt for `tsc` totality (the runtime key set can only
  come from `MessageId`) — the fixtures are the teeth. SHAPE-04: the `tf` identifier at a word boundary,
  whitespace and one balanced `<…>` skipped, then `(` and a string literal starting with `a11y.` —
  receivers (`this.tf(`) deliberately NOT exempted, the inverse of the S2 scanner's rule; plus no `{`/`}`
  in any `a11y.*` value in `CATALOGS` or `a11yCopy`; `messageIds.ts` `AssertNoA11yParamKey` is the
  compile-time half. SHAPE-05: exactly one `export function t(` whose whole balanced-paren parameter
  span EQUALS `key: A11yKey | PlainMessageId` and returns `: string` (`t.length` is not evidence — rest
  and default parameters do not count). SHAPE-06: `new Intl.PluralRules(locale).resolvedOptions()
  .pluralCategories`; a locale whose set is not exactly `{one, other}` may not reference the identifier
  `oneOther` at all — call, spaced call, `import { oneOther as x }`, `const oo = oneOther` and the
  quoted `'oneOther'` string-index form all count.
- **D7 Shared precondition.** Every SHAPE check first asserts the discovered `catalog.<locale>.ts` set
  (name starts `catalog.`, ends `.ts`, not `.test.ts`) EQUALS `Object.keys(CATALOGS)`, non-empty, and
  SHAPE-01's parsed key set EQUALS `Object.keys(CATALOGS[locale])` — a mis-named or unregistered S7
  file reds every gate loudly instead of vacating them silently.
- **D8 Proof shape.** `main.i18nBoot.test.ts` imports `main.ts` at runtime (the 16r-f/17r-a harness)
  and records `lang`/`dir` by wrapping `documentElement.setAttribute` — happy-dom's property setters
  funnel through it, and an accessor shadow both misses `setAttribute` and leaks across tests in the
  same file (measured). The resolver mock's registry is a mutable object reset per test because a
  `vi.mock` factory runs once per FILE, not per `vi.resetModules()` generation (measured: 4/7 tests
  could never pass under the first draft). BOOT-05/06 pin the hunk's and the six calls' exact text on
  comment-stripped, whitespace-squashed source, exactly once, in order — deliberate seam pins.

## Consequences

- Every test that imports `main.ts` now runs `setLocale('en')` at import — harmless, the cell's initial
  value.
- The RTL branch is proof-of-wiring only (a mocked `{en, he}` registry) until S7 registers a second
  locale. Under node 24's ICU, `fr` is `{one, many, other}` — **S7's `catalog.fr.ts` must not call
  `oneOther`** or SHAPE-06 reds it; it must be registered in `CATALOGS` or D7 reds every gate.
- Catalog entries must not use a nested template literal (a backtick inside `${…}`): SHAPE-01's and
  SHAPE-06's scanners do not model that shape and would false-GREEN, not false-RED. No entry does today.
- Accepted limit (SHAPE-04): indirection such as `[tf][0]('a11y.x', …)` or a local `const f = tf` is
  not a text-scannable call site; S7's DYNAMIC-KEY gate (I18N-27) and `tsc` totality (an `a11y.*`
  literal is never a `ParamMessageId`, so only an `as never` cast compiles) are the backstops.
- SHAPE-01's "≥10 non-whitespace characters" is the spec's letter and accepts punctuation; a content
  requirement is a review item, not a gate.
- `chrome.helpHint`: D5. The eight uncatalogued disconnect feedbacks: D4. Both are S7-visible residuals.
- `**Extends:**` is unmodelled by `adr-digest`, so 0256/0257/0261 carry no back-link edit.

## Lenses

planner → reviewer ∥ red-team ∥ /simplify (plan; the red-team's setAttribute-wrapper, `getAll` fixture,
SHAPE-04 receiver, SHAPE-05 exact-span and SHAPE-06 identifier-token corrections all landed) → tester ×2
(disjoint files; BOOT RED 7/7 at HEAD, SHAPE green with fixture-proven teeth) → reviewer ∥
red-team-writes-the-cheat (tests; found the once-per-file mock factory, the biome specifier order and
the `plural['oneOther']` bypass — all fixed by the testers) → specialist (`main.ts` only) → verifier.
Domain auditors n/a (no server / game-core surface). The landing-pattern flag appeared after the
test lenses, so docs were written inline by the orchestrator. Lens outcomes are in the PR body and the
harness plan file `memory/projects/monster-realm-m24-s6-plan.md`.
