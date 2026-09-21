# ADR-0264 — ICU MessageFormat as interchange only: source-parsed catalog export/import with an exporter-derived params contract, an explicit `translated` marker, and a nightly-only completion baseline (M24 S8)

**Status:** Accepted
**Date:** 2026-09-21
**Slice:** m24-s8 (M24-internationalization S8 — the ICU round-trip shim, final slice of the milestone)
**Supersedes:** —
**Amends:** —
**Extends:** 0256, 0263
**Subsystems:** tooling-docs, client-ui
**Decision:** `catalog-export.mjs`/`catalog-import.mjs` round-trip `catalog.<tag>.ts` ⇄ ICU JSON by parsing source with RegExp-free walkers (plural-only subset); completion is an explicit `@translated` marker, gap-ratcheted nightly, never a ci gate.

---

## Context

M24 §2.6 settles the format arbitration: ICU MessageFormat is the export/import format of record and
is **never parsed at runtime** (ADR-0055 bans dynamic `RegExp`; a runtime ICU parser is cut C3).
S8 is the last slice of the milestone; S0–S7 delivered the seam it serialises — the flat
`MessageId` union and the compile-total `Catalog` (ADR-0256 D2), the `// @desc:` convention
machine-checked by SHAPE-01 (ADR-0262), the frozen `CATALOGS` registry, and the first real plural
(`catalog.fr.ts` `battle.weather.banner` = `${selectPlural('fr', p.turns, WEATHER_TURN_FORMS)}`,
ADR-0263 consequence: "S8 must serialise a `selectPlural` closure as ICU plural and treat
`WEATHER_TURN_FORMS` as catalog data, not code"). §5.5 adds the nightly-only completion baseline
whose count is driven by an explicit per-key `translated: boolean`, not a string-inequality
heuristic (B4's own risk-3 falsifies inequality: `en` plus a trailing space defeats it, and five fr
keys legitimately equal their English source).

Facts that shaped the slice: (1) every live catalog value is either a single-quoted string or a
`(p) => \`…\`` template whose holes are `${p.<ident>}` or `${selectPlural('<tag>', p.<ident>,
<CONST>)}`, the const hoisted as `cldr({ zero…other })` — a closed grammar of two shapes. (2) biome
(`quoteStyle: single`, Prettier's fewest-escapes rule) rewrites `'it\'s'` to `"it's"`, so an
emitter that only reads single quotes breaks its own next export the first time a translation
carries an ASCII apostrophe — measured during plan review. (3) `Intl.PluralRules` gives fr
`{one, many, other}`, ru `{one, few, many, other}`, ar all six; the dead categories a two- or
three-category locale still authors (ADR-0256 D2 totality) are noise to a translator. (4)
`CONTENT_VERSION` is **22** at HEAD (rb-82); the spec's I18N-31 "21" is stale, as ADR-0263 recorded.
(5) `.github/workflows/nightly.yml` and `docs/nightly-red-response-policy.md` are outside the
declared `touches:`; a new nightly job forces a policy-doc row, a `notify.needs` entry and a
preamble (`evals/nightly-smoke-wiring.eval.mjs`), so the nightly *wiring* is a hidden dependency.
(6) Spec §8 item 5 asks whether the shim is earned with no named TMS vendor and says it
**DEFAULTS to building it in S8** if unanswered.

## Considered alternatives

- **A runtime ICU MessageFormat parser** — cut (C3, ADR-0055); a non-count `select` stays an
  engineer PR, and the vendor still receives real ICU through the shim.
- **Loading the TS catalog at runtime (esbuild/vitest import) instead of parsing source** —
  rejected: `// @desc:` lines, citation lines and the `@translated` marker are comments, invisible
  at runtime, and a closure is opaque (its holes cannot be recovered from a function object).
- **A string-inequality completion heuristic ("differs from en")** — rejected by the spec (§5.5,
  B4 refuted column); the flag is explicit data the importer writes.
- **Emitting all six CLDR categories** — rejected: unreachable branches a translator would edit
  to no effect; the export carries only the locale's live set, the importer refills dead
  categories from `other` (the same rule `oneOther` applies), the record stays total.
- **`oneOther(...)` emission for two-category locales** — rejected: a second emitter code path,
  and `catalog.test.ts`'s raw `oneOther(` scan would have to reason about it; `cldr({…})` always.
- **Parsing hoisted `oneOther(a, b)` consts** — rejected (no live use; the emitter never writes
  it); a future `oneOther` plural reds export with `PARSE` naming the line, reject-not-clamp.
- **Carrying citation lines as a separate `notes[]` field with a citation heuristic and 100-col
  re-wrapping** — rejected after review: the block is carried VERBATIM as a multi-line
  `description` (first line `@desc:`), which makes the round trip byte-exact with no heuristic.
- **A `tsc` spawn as the round-trip oracle** — rejected: forgeable (`// @ts-nocheck`, `as
  Catalog`) and redundant with the runtime-truth oracle (D10); the real-import path typechecks via
  the `just i18n-import` recipe instead.
- **Comparing `total` in the nightly ratchet** — rejected: every key-adding slice would red the
  nightly; the spec's ratchet is on the GAP count only.
- **`evals/i18n-*.eval.mjs` for I18N-29/30** — rejected (ADR-0224; the milestone's vehicle is a
  co-located vitest test, as S0/S2/S6/S7).
- **Editing `nightly.yml` from this slice** — rejected: outside `touches:`; DEFERred (D8).
- **Deferring S8 pending a named vendor (spec §8-5)** — the documented default was taken (D9).

## Decision

- **D1 Vehicle.** I18N-29/I18N-30 ship as `client/src/ui/i18n/catalogRoundTrip.test.ts` (13 tests,
  `describe(…, { sequential: true })`), which statically imports the two main-guarded `.mjs`
  scripts — the same `.ts`-imports-`.mjs` shape as `catalogShape.test.ts` → `stripComments`.
- **D2 Source, not runtime.** `parseCatalogSource(source, { tag, file })` is a RegExp-free
  line/cursor walker over the RAW file: hoisted `const X = cldr({…})` forms, then every entry of
  `export const CATALOG_<X>: Catalog = Object.freeze({ … } satisfies Catalog)` — the contiguous
  `//` block directly above (first line MUST be `// @desc:`; a block not directly above an entry
  is ignored, exactly SHAPE-01), the key, and a value that is a `'…'`/`"…"` string or a
  `(p) => \`…\`` template with `${p.x}` / `${selectPlural('<tag>', p.n, CONST)}` holes. Entry model:
  `{ key, kind, text, params (first-appearance order), plurals[param] (six forms), description
  (block lines verbatim, `\n`-joined, `@translated:` lines excluded), translated }`. Every other
  shape — double-quoted-in-template, concatenation, a `${` in a plain string, a nested backtick, a
  plural tag ≠ the file tag, an unresolved const, a duplicate key, a trailing comment on an entry
  line, a bad `@translated` value — is `PARSE <file>:<line>: …`, never a guess (reject-not-clamp,
  ADR-0205 D4 stance). Errors are `Object.assign(new Error('catalog-export: <CODE> …'), { code })`.
- **D3 ICU emission** (`toIcuMessage`). `${p.x}` → `{x}`; a plural hole → `{n, plural, one {…}
  many {…} other {…}}` carrying ONLY `liveCategories(tag)` (canonical `zero,one,two,few,many,other`
  filtered by `Intl.PluralRules(tag).resolvedOptions().pluralCategories`; `other` is always live).
  Quoting is ICU4J-faithful: each MAXIMAL RUN of special characters (`{` `}` at top level; `{` `}`
  `#` inside a branch; `|` never) becomes ONE quoted span with inner apostrophes doubled
  (`{}`→`'{}'`, `{'}`→`'{''}'`), and a `'` not adjacent to a special becomes `''`. Top-level `#`
  (`Species #{id}`) is untouched.
- **D4 The interchange document.** `build/i18n/<tag>.icu.json` (gitignored artefact, no
  timestamp, `JSON.stringify(o, null, 2) + '\n'`): `{ locale, sourceLocale: 'en', generatedBy,
  messages: { <key>: { message, description, params, translated } } }` in catalog order. `params`
  is exporter-derived from the holes and is the **arity contract** the importer enforces against
  the en roster; `description` is the verbatim block (D2).
- **D5 `translated` is explicit data whose catalog SSOT is a marker.** The importer writes
  `  // @translated: false` as the LAST line of an entry's block for every message whose JSON says
  `translated: false`; it never writes `true`. The exporter reads `false` → false, `true` or no
  marker → true (a hand-authored entry is translated by definition). `--seed <tag>` is the only
  sanctioned producer of a `false` document: the en model re-labelled `locale=<tag>` with every
  `translated: false`. A `translated` that is absent or non-boolean on import is
  `TRANSLATED-NOT-BOOLEAN`.
- **D6 Importer validation** (`validateImport`, pure; `importLocale` adds the write). ICU decoding
  is DOUBLE_OPTIONAL (`''`→`'`; `'` before a context-special opens a span ending at the next lone
  `'`, `''` inside stays literal; a lone `'` before a non-special is a literal apostrophe — so a
  TMS's `l'aide` re-imports). Codes: `LOCALE-MISMATCH`, `LOCALE-UNSUPPORTED`, `LOCALE-IS-SOURCE`
  (`en` is never overwritten — checked before any write), `KEY-SET-MISMATCH` (vs the parsed en
  catalog, both directions, keys named), `PARAMS-MISMATCH` (ICU arg set vs the en roster; a
  supplied `params` must equal it), `PLURAL-CATEGORIES` (set ≠ the locale's live set,
  order-insensitive), `ICU-SYNTAX`, `ICU-UNSUPPORTED` (`select`/`selectordinal`/other types, `=N`,
  `offset:`, nesting, a second plural on one arg, a plural on a non-roster arg, `${`), `ICU-HASH`
  (an unquoted `#` in a branch — a count placeholder the catalog cannot express), `MSG-EMPTY`,
  `CONTROL-CHAR` (< 0x20, 0x7F, U+2028, U+2029 in message/branch/description — line-separator
  injection into the emitted TS), `DESC-INVALID` (first line < 10 non-whitespace, a line starting
  with `@`, or a line ending in whitespace — biome trims it and the identity would silently
  break), `FORMS-NAME-COLLISION`, `JSON-INVALID`, and `EMIT-MISMATCH`: the emitted text is
  re-parsed with `parseCatalogSource` and compared to the validated model BEFORE the
  `<out>.tmp` → rename write.
- **D7 Emitted shape** (`emitCatalogTs`). A generated header (no braces, no `oneOther(`, no
  `@desc:` decoy), `import type { Catalog } from './messageIds';`, `import { cldr, selectPlural }
  from './plural';` only when a plural exists, one `const <KEY_UPPER>_<PARAM_UPPER>_FORMS =
  cldr({…})` per plural with UNQUOTED keys and dead categories = the `other` form, `export const
  CATALOG_<TAG>: Catalog = Object.freeze({` … `} satisfies Catalog);` in en order; plain values and
  forms take biome's quote (double when the text has `'` and no `"`) so the file is format-stable;
  closures are `(p) => \`…\`` with `${p.x}` / `${selectPlural('<tag>', p.n, CONST)}`. Registration
  of a NEW locale stays manual and is printed on import: `resolver.ts` `CATALOGS`,
  `resolver.test.ts`, `catalogParity.test.ts` `PLURAL_CATEGORIES` (and `PLURAL_PARAM_KEYS` when the
  locale pluralises a key en does not).
- **D8 Completion baseline** `evals/baselines/i18n-locale-completion.json` = `{ <tag>: { total,
  translated, gap } }`, written by `--completion`, GAP-ONLY ratchet: the writer refuses to record a
  gap larger than the committed one for an existing tag (exit 1, `REGRESSION gap b -> l`, file
  untouched; no override flag — the fix is to translate); `--completion --check` classifies each
  tag `OK` | `REGRESSION` (tag missing live, or gap grew) | `STALE` (gap shrank, or tag not in the
  baseline) | `BASELINE-MISSING`, prints one `i18n-completion: <tag> total=… translated=… gap=…
  <verdict>` line per tag plus a summary, exit 1 on any non-OK. `total`/`translated` are
  informational. Recipes: `just i18n-export`, `just i18n-import <locale> <file>` (import → biome
  format → `just client-typecheck` → refresh baseline), `just i18n-completion`,
  `just i18n-completion-check`. **Never in `ci:`.** The nightly job that runs
  `i18n-completion-check` is DEFERred to `backlog` (ledger X13): a 3-place edit outside `touches:`
  — a job with a `#` preamble citing `docs/nightly-red-response-policy.md`, a policy-doc row, a
  `notify.needs` entry.
- **D9 Decision-default recorded.** `decision-defaulted:m24-s8-icu-shim-earned-with-no-named-vendor=YES-BUILD-IT`
  — spec §8 item 5 asks whether the ICU round-trip shim is earned absent a named TMS vendor and
  states it "DEFAULTS to building it in S8" if unanswered. This is a reversible scope choice
  (deferring costs nothing to revisit later, per the spec's own framing) with an explicit
  documented default, not an architectural, irreversible or security decision, so the default was
  taken under BLOCKER discipline without a blocking `mr-ask-drew` round-trip. The spec's own
  deferral condition stands recorded: if the operator has no localization plan at all, S8 should
  have been deferred with S7 as the milestone's end — the shim is one slice against 112 entries
  today and would be a migration against 40 screens of accreted keys later (B5's argument).
- **D10 The I18N-29 oracle.** For each live tag: `J1 = export(parse(catalog.<tag>.ts))`,
  `T = biome-format(emit(import(J1)))` (the REAL formatter, spawned), `J2 = export(parse(T))`;
  `J1 === J2` byte-identical, key ORDER / kinds / param sets / live plural forms equal, AND the
  formatted `T` is dynamically imported and every key compared at runtime against
  `CATALOG_EN`/`CATALOG_FR` (plain values `===`; all 35 closures called with distinctive per-field
  samples, fr `turns` at 1, 2 and 10⁶). I18N-30 is a RegExp-free scan of both scripts (`RegExp`
  identifier, `new RegExp(`, `.test(`/`.exec(`, a regex-literal detector, an import-specifier
  roster ⊆ {`node:fs`, `node:path`, `node:url`, `node:process`, `./catalog-export.mjs`}, no
  `Function(`/`eval(`/`import(`/`require(`/`getBuiltinModule`/`globalThis`) PLUS a behavioural
  oracle that installs throwing wrappers on `String.prototype.{replace,replaceAll,split,match,
  matchAll,search}` (non-string first argument) and `RegExp.prototype.{test,exec,[Symbol.*]}` while
  export, import and every rejection fixture run. I18N-31 is pinned at `CONTENT_VERSION` **22**.

## Consequences

- A translator sees only reachable plural branches and the verbatim `@desc` block; a TMS that
  passes the metadata through returns a document the importer accepts unchanged.
- `just i18n-import` of an existing locale REPLACES its file-level header: `catalog.fr.ts`'s
  36-line typography rationale and the `WEATHER_TURN_FORMS` comment are not round-tripped (only
  entry blocks are), and the const is renamed `BATTLE_WEATHER_BANNER_TURNS_FORMS`. Importing `en`
  is refused.
- Adding a locale = `just i18n-export --seed` (via `node scripts/catalog-export.mjs --seed <tag>`),
  translate, `just i18n-import`, then the four manual registration edits ADR-0263 named.
- A hand edit that breaks the two-shape grammar reds `just i18n-export` with a `PARSE` line, never
  a wrong document; a hand-deleted `// @translated: false` shows as `STALE` nightly (the regen
  recipe is the fix, and the baseline diff is visible in review).
- The nightly report is NOT live until the deferred wiring lands; until then
  `just i18n-completion-check` is an operator command.
- No catalog, resolver, plural, `game-core/`, `server-module/` or `styles.css` file changed —
  `bindings-drift` 0, `battle-schema-snapshot` byte-identical, `CONTENT_VERSION` 22 (spec 21 stale).
- Spec drift for the supervisor: §4 S8 row as-built (`--i18n-dir`, `--seed`, four recipes, the
  nightly job deferred); §5.5 "reported nightly" pending X13; I18N-31/E11 21 → 22.

## Lenses

planner → reviewer ∥ red-team (plan; amendments A1–A13: maximal-run ICU quoting + DOUBLE_OPTIONAL
decode, biome quote-flip through the real formatter, control-char rejection + self-re-parse,
gap-only ratchet with writer refusal, verbatim description, structured `err.code`, `--seed`,
runtime-truth oracle replacing tsc, behavioural RegExp oracle) → tester (RED at HEAD: collection
failure, scripts absent) → red-team-writes-the-cheat on the suite ∥ specialist (13/13) → tester
strengthening (description-line census, RegExp-side dispatch wrappers + literal detector, `from`
roster in code state, `params` pin, `--i18n-dir` for the writer-refusal test, unguarded-main
probe) → specialist catch-up → reviewer (+ simplify lens) ∥ verifier. Domain auditors n/a (no
server / game-core surface). Lens outcomes in the PR body and
`memory/projects/monster-realm-m24-s8-plan.md`.
