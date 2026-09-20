# ADR-0256 — The i18n module: a compile-total catalog, a module-level locale cell, an empty a11y union, and the type guarantees proven by a negative compile in vitest (M24 S1)

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** m24-s1 (M24-internationalization S1 — the i18n module, types only, zero call-site migration)
**Supersedes:** —
**Amends:** —
**Extends:** 0205, 0224
**Subsystems:** client-ui, ci-gates
**Decision:** `client/src/ui/i18n/` ships a literal `MessageId` union, a mapped-type-total `Catalog`, a throw-on-miss resolver whose locale is one module-level cell, CLDR-total plural forms paid for once by `oneOther`/`cldr`, and its four compile-time guarantees are proven by spawning `tsc` over fixtures from a co-located vitest test.

---

## Context

M24 (harness spec `M24-internationalization.spec.md`, binding strategy harness ADR-0033 as amended
2026-09-19) externalizes the client's chrome strings into a catalog. Its central design decision
(§2.0, §2.3) is that the catalog is a **compile-time-total TypeScript module** — omitting a key from a
locale, passing the wrong parameter set, handing an `a11y.*` key to the parameterized resolver, or
omitting a CLDR plural category are all `tsc` errors, never runtime blanks. ADR-0033's amendment #3
upgrades "a new language is a data drop" to "a **typed** drop" for exactly this reason. S1 is the slice
that creates the module; it migrates **zero** call sites (`main.ts`, `index.html` and the 19 views are
S3–S6's) and seeds only the `chrome.*` namespace.

Four things the spec leaves open or gets wrong had to be decided here:

1. **Where the current locale lives.** `t(key): string` is pinned byte-identical to M23 §2.8
   (`[I18N-SHAPE-05]`) and `tf(key, params): string` mirrors it — neither takes a locale argument, so
   the resolver needs a locale source that is not a parameter.
2. **The a11y seam.** Spec §2.8 says S1's resolver "imports `A11Y_COPY_EN` if it exists and compiles
   against an empty a11y union if it does not". M23 landed `client/src/ui/a11yCopy.ts` exporting
   `a11yCopy: Readonly<Record<string, string>>` — no `A11Y_COPY_EN`, and a key type of `string`.
3. **How to prove a compile-time criterion.** I18N-6..9 are "SHALL fail `client-typecheck`", but
   `client/tsconfig.json` excludes `**/*.test.ts`, so nothing written in a test is typechecked, and
   ADR-0224 forbids a new `evals/*.eval.mjs` scanner.
4. **The key grammar.** Spec §5.4 `[I18N-SHAPE-03]` pins `/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/`, which
   rejects the spec's own `chrome.helpHint` (§5.4 SHAPE-02) and `battle.hpLine` (§2.3). M23 hit the
   identical contradiction for `a11y.overlay.boxView.title` and resolved it in ADR-0205 D5.

## Considered alternatives

- **D1 resolver state.** (a) *Chosen:* a frozen registry `CATALOGS = Object.freeze({ en: CATALOG_EN })`
  plus one module-level `let current = 'en'`, with `setLocale(locale)` that **throws** on an
  unregistered locale and leaves the cell unchanged, and `currentLocale()`. (b) A `createResolver()`
  factory returning `{ t, tf }` — rejected: SHAPE-05 pins `t` as a *named module export* with M23's
  exact signature, so a factory needs the same singleton underneath plus a second shape. (c)
  `setLocale` clamping an unknown locale to `'en'` — rejected: it makes an unwired locale look wired,
  the vacuity ADR-0205 D4 exists to kill (same reasoning as `a11yCopy.t` throwing rather than
  returning the key).
- **D2 totality.** (a) *Chosen:* `type Catalog = { readonly [K in MessageId]: K extends
  ParamMessageId ? (p: MessageParams[K]) => string : string }`, the English literal written as
  `Object.freeze({ … } satisfies Catalog)` (the `satisfies` is load-bearing — `Object.freeze<T>` is
  generic and would swallow a stowaway key; `satisfies` restores the excess-property check), and
  `PluralForms = Readonly<Record<Intl.LDMLPluralRule, string>>` **never** weakened to `Partial`. The
  four permanently-dead categories a two-category locale would otherwise author are filled once by
  `oneOther(one, other)`; `cldr(forms)` is the identity for a locale that needs all six. (b)
  `Partial<Record<…>>` plural forms — rejected: reintroduces the runtime blank and destroys "a Russian
  catalog omitting `few` does not compile". (c) Branching on `n === 1` at call sites — rejected:
  structurally incapable of four categories (spec §2.0 point 1).
- **D3 proving I18N-6..9.** (a) *Chosen:* one co-located vitest file writes GOOD and BAD probe
  modules to a fresh temp dir, spawns `client/node_modules/.bin/tsc --noEmit --strict
  --noUnusedLocals --noUnusedParameters --target ES2022 --module ESNext --moduleResolution bundler
  --skipLibCheck` **once** over all of them (the ADR-0205 D6 mechanism, extended with the two
  unused-checks so the probe compiles under the same rules as `client/tsconfig.json:7-8`), buckets the
  `file(line,col): error TSnnnn` diagnostics by fixture, and asserts the **exact error-code set** per
  BAD fixture, zero diagnostics on the GOOD fixture that imports every real export, and TS2322 on an
  always-red control (the compile path executes). Red-team measured two hazards this design absorbs:
  a single spawn shares *global* scope across script-mode files (so every fixture is a module with
  uniquely-named `export`ed bindings), and a present-but-mistyped object-literal property reports
  TS2322 on the property rather than TS2345 on the argument. (b) `// @ts-expect-error` fixtures —
  rejected: not house style (zero occurrences in `client/src`, ADR-0205 D6) and "zero diagnostics"
  accepts *any* error at the line, so it cannot name the property being proven. (c) A text pin on the
  type declarations — rejected: ADR-0205 D6 measured a used-decoy-string bypass.
- **D4 the a11y union.** (a) *Chosen:* `export type A11yKey = never` in `messageIds.ts`, so
  `t(key: A11yKey | PlainMessageId)` collapses to `t(key: PlainMessageId)` today and a future flip is
  a pure widening with no call-site break. (b) Importing `a11yCopy` and deriving
  `keyof typeof a11yCopy` — rejected: that is `string`, which widens `t` to `(key: string) => string`
  and silently destroys SHAPE-05 and every totality guarantee (the compile suite's `bad-t-wide`
  fixture is the transitive oracle for exactly this widening). (c) Editing `a11yCopy.ts` to export a
  literal-typed `A11Y_COPY_EN` — out of this slice's `touches:` (a hidden dependency; flagged as a
  follow-up, not smuggled in).
- **D5 key grammar.** *Chosen:* segments `[a-z][a-zA-Z0-9]*`, at least two, dot-separated — the
  ADR-0205 D5 resolution (`OverlayId` kept verbatim inside a key). The spec's own BAD fixture
  `Battle.HPLine` still fails. The spec text is corrected upstream by S6's shape gate, not here.
- **D6 locale negotiation.** *Chosen:* `negotiateLocale(requested, available)` is an RFC 4647 lookup
  — per requested tag in order, case-insensitive, truncating on `-` until a match, returning the
  `available` spelling; no match or an empty `requested` → `'en'`; an `available` set that does not
  contain `'en'` **throws** (a registry without the source locale is a programming error, and
  clamping would return a locale the resolver cannot serve). `isRtl(locale)` is a static
  primary-subtag table (`ar he fa ur ps yi`); `Intl.Locale.prototype.getTextInfo` was rejected as
  not universally shipped. `selectPlural`/`fmtNumber` throw when `Intl.*.supportedLocalesOf` returns
  empty for the locale — `new Intl.PluralRules('xx')` otherwise resolves *silently* to `en-US` and
  would ship English plural rules under a typo'd tag.
- **D7 parameter table direction.** *Chosen:* `MessageParams` is the single hand-written table and
  `ParamMessageId = keyof MessageParams`; spec §2.3's prose has the inverse derivation. Isomorphic;
  one table instead of two lists to keep in sync. A `MessageParams` key that is not a `MessageId`
  fails to compile at the resolver's `CATALOGS[current][key]` indexing.

## Decision outcome

The module is five files under `client/src/ui/i18n/` — `messageIds.ts` (the SSOT union and types),
`catalog.en.ts` (ten `chrome.*` entries, each with a `// @desc:` line), `resolver.ts` (`t`, `tf`,
`setLocale`, `currentLocale`, `CATALOGS`, `DEFAULT_LOCALE`), `plural.ts` (`selectPlural`,
`fmtNumber`, `oneOther`, `cldr`), `locale.ts` (`negotiateLocale`, `isRtl`) — with no `RegExp` use,
no IO, and no import from outside the directory. Per ADR-0224 every guarantee is an ordinary
co-located vitest test; no `evals/*.eval.mjs` file is created.

## Consequences

- A missing key, a wrong parameter shape, an `a11y.*` key reaching `tf`, and a two-category plural
  literal reaching `selectPlural` are each a `tsc` error, and each is proven so by a fixture whose
  exact diagnostic code is asserted — the compile path itself is proven live by a control fixture.
- **Named residual:** a JavaScript caller (or an `as never` cast) can pass `{ where: undefined }` to
  the `chrome.status.disconnected` closure and render `undefined: disconnected`. Typed call sites
  cannot; no runtime parameter validation is added (YAGNI). Casts are the caller's lie and are
  outside a type gate's reach; the runtime backstops (`Object.hasOwn` miss, wrong-resolver key) throw.
- **Follow-ups this slice does not perform:** (a) `a11yCopy.ts` should export a literal-typed
  `A11Y_COPY_EN` so `A11yKey` can flip from `never` (M23's soft ask); (b) S6 consumes
  `negotiateLocale`/`setLocale`/`isRtl`/`currentLocale` at boot; (c) S7 must add `fr` to
  `resolver.ts`'s `CATALOGS` — a file absent from S7's declared `touches:` in spec §4; (d) spec §4.1's
  `43+77+45+4 = 169` closure assumes `main.ts` holds 4 chrome strings — 6 `reportError` literals were
  measured (main.ts:582, 651, 961, 1040, 2442, 2524), so S2 re-measures before seeding
  `HARDCODED_CEILING`; (e) spec §5.4 SHAPE-03's grammar needs the D5 correction upstream.
