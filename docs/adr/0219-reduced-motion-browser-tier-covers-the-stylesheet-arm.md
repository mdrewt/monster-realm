# 0219 — The reduced-motion browser tier covers A11Y-27's stylesheet arm only, because the renderer arm was never wired into main.ts

**Status:** Accepted
**Date:** 2026-08-30
**Slice:** rb-20 (residual R-m23-s11-X11)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-ui
**Decision:** Gate A11Y-27's STYLESHEET arm in a real browser with a `reduced-motion` Playwright project (spelled `contextOptions.reducedMotion`) collecting one new spec, as half 4 of `just a11y-e2e`; the renderer arm is unwired and DEFERred.

---

## Context and problem statement

Residual R-m23-s11-X11 asked for "the cheapest real-browser a11y oracle
available": a Playwright project configured with `use: { reducedMotion:
'reduce' }`, on the stated grounds that `renderResolver.test.ts` "proves the
pure branch but nothing proves the media query actually reaches it end to end".
m23-s11 could not land it because `client/playwright.config.ts` was outside its
`touches:`. This slice owns that file.

Building it surfaced something the residual's author did not know.

## Decision 1 — the tier's claim is the STYLESHEET arm, not the renderer arm

**Measured on `3b2bcb2`: A11Y-27's renderer arm is not wired in production.**

`client/src/render/motionPreference.ts` states its own delivery contract in its
header — "S7 → S5 CROSS-SLICE CONTRACT: S7 ships this module UNCONSUMED. S5
(the sole main.ts slice) wires it at the existing render-loop call site." That
wiring never landed:

- `motionPreferenceFromWindow` has **zero** production importers. Searching
  non-test `client/src` for `motionPreference`/`reduceMotion` returns hits in
  exactly two files: the module that defines it and `renderResolver.ts`, which
  declares the `ResolveInput.reduceMotion` field that consumes it.
- `client/src/main.ts:2807` calls `resolver.resolve({ characters, ownEntityId,
  predicted, snapped, now, currentZoneId })`. There is no `reduceMotion` key, so
  `renderResolver.ts:83`'s `reduceMotion = false` parameter default applies on
  every frame of the shipped client.

So the OS preference reaches nothing in the renderer, and **no browser oracle
can make that arm green** — the fix is one call-site edit in `main.ts`, which is
outside this slice's `touches:`. Writing a browser test that asserts the
renderer honours reduced motion would red permanently; writing one that asserts
the current behaviour would cement the bug.

What *is* end-to-end reachable is the stylesheet arm, shipped by rb-10 and
hardened by rb-17 at `client/src/styles.css:91-99`:

```css
.hp-fill { transition: width 0.3s; }
@media (prefers-reduced-motion: reduce) { .hp-fill { transition: none; } }
```

It is loaded by a `<link>` in `client/index.html:12` rather than by a `.ts`
import, so it applies on a bare `page.goto('/')` — no SpacetimeDB connection, no
player join, no RNG. And its entire mechanism *is* the browser's media-query
engine, which is precisely the thing happy-dom cannot model and precisely what
the residual says is unproven. `evals/reduced-motion-hp-bar.eval.mjs` already
pins that rule's text (order, spelling, no custom property); nothing anywhere
proved Chromium *evaluates* it.

The renderer arm is deferred to `backlog` on the ledger with this measurement as
its evidence, so it becomes a queued spec section rather than a sentence in a
handoff.

**Consequence a later reader must not undo:** every test name, the recipe
banner and this ADR say *stylesheet arm*. Relabelling this tier "A11Y-27,
gated" would be a false green of exactly the kind the tier exists to prevent.

## Decision 2 — `testMatch` on the new project, so the axe scan does NOT also run under reduced motion

`playwright.config.ts` collects by `testDir: './e2e'`, so a naively-declared
project inherits **every** e2e spec — including rb-19's `a11y.spec.ts`. The
launch brief required this be decided deliberately. It is decided: the new
project carries a `testMatch` naming the single new spec file, which is strictly
narrower than the `testIgnore` alternative and cannot silently widen when a
future spec file is added.

The structurally stronger shape — giving the new project its own `testDir`, so a
file lives in exactly one directory and double-collection is impossible rather
than merely excluded — was considered and **rejected on scope, not on merit**. It
requires a new directory outside this slice's declared `touches:` (which names
`client/e2e/reduced-motion.spec.ts` literally), and the loop's rule is to surface
a path outside the declared set rather than widen the slice. A later slice that
grows a second reduced-motion spec should make that `git mv` rather than add a
second entry to two coupled constants.

`a11y.spec.ts` therefore does **not** run under reduced motion. Three reasons,
in order of weight:

1. **Shared-world safety.** `a11y.spec.ts`'s header records that the suite keeps
   "exactly one context, closed in afterAll", because `golden.spec.ts` asserts
   an exact `presenceCount === 2` and "a leaked context here reds a DIFFERENT
   spec file"; it closes with "Adding a second context here would break that and
   must not be done without renaming the file." A second project collecting that
   file is a second context under another name.
2. **It would prove nothing.** The tier's tag list is
   `wcag2a/wcag2aa/wcag21a/wcag21aa/wcag22aa`. No rule in that set has an outcome
   that depends on `prefers-reduced-motion`; WCAG's motion criterion (SC 2.3.3,
   Animation from Interactions) is **Level AAA** and is explicitly outside the
   §5.6 conformance claim. The second scan would re-derive the first verdict.
3. **It would break half 3's arithmetic.** Half 3 asserts `stats.expected >=
   axefloor` over a report; collecting the file twice doubles the reported test
   count and doubles the three measured `passes` floors and three
   `incomplete` ceilings that make that tier non-vacuous.

The symmetric half of this decision is **not** optional: the `default` project
carries a `testIgnore` for the new spec. Without it the new spec is also
collected with no emulation, its first assertion fails, and every PR reds.

## Decision 3 — the oracle asserts BOTH polarities, and asserts the config, not an in-test call

A single `transitionDuration === '0s'` assertion is satisfied by at least three
wrong worlds: a stylesheet that never loaded, a `transition: none` written
unconditionally, and a probe element that never entered the document. So the
spec asserts the mirror image on the same page via `emulateMedia({ reducedMotion:
'no-preference' })` — `matches === false` and the same probe reporting `0.3s`.

The two polarities are two `test()` bodies over the built-in `page` fixture, so
each gets a fresh context and the flip cannot leak forward. (Measured on the
rejected shared-context shape: `emulateMedia` set in one test persists into every
later test in the file — a live trap for the RM-7 follow-up slice, which the
DEFER note points at this same file.)

And the positive test performs **no `emulateMedia` call at all**. That is the
whole gate: `page.emulateMedia({ reducedMotion: 'reduce' })`
inside the test would keep it green with `use: { reducedMotion: 'reduce' }`
deleted from the config, which is to say it would gate nothing.

## Decision 4 — half 4 of `just a11y-e2e`, nightly, with a `case`-guarded floor

The tier is wired where §5.7 put the rest of the a11y browser work rather than
into `just ci`: the nightly `a11y-e2e:` job already provisions chromium, Rust,
wasm-pack and a live SpacetimeDB, and `globalSetup` takes that server dependency
unconditionally (ADR-0218 D1). No new nightly job key is added — half 4 rides the
existing `- run: just a11y-e2e` step.

`--project=reduced-motion` on the invocation is load-bearing: without it the
recipe runs every e2e spec. The floor is read from the JSON report and never from console text — though the
precise vacuity it defends against is **not** the one half 3's comment names.
Measured on 1.61.1: a missing spec file, a `--project` naming no project, and an
empty spec file all exit **1** with `No tests found`, so `set -euo pipefail`
kills the recipe before the floor check runs. The shape that really does report
`expected: 0` and exit **0** is a wholly `test.describe.skip`'d file — which the
`s.skipped !== 0` clause catches. Half 4 states that accurately rather than
inheriting half 3's stale rationale. The new `rmfloor` parameter is
`case`-guarded as a non-negative integer for the reason ADR-0183 D7 records: `Number('')` is `0` and `Number('abc')` is `NaN`,
and `expected < NaN` is `false`, so an empty or non-numeric floor prints OK on a
zero-test report.

## Decision 5 — the spelling is `contextOptions.reducedMotion`, measured, not assumed

The residual (and every Playwright doc page written against a newer release)
says `use: { reducedMotion: 'reduce' }`. **That option does not exist in this
repo's pinned `@playwright/test` 1.61.1.** `node_modules/playwright/types/test.d.ts`
contains exactly one occurrence of the string `reducedMotion`, and it is inside
the *doc comment* for `contextOptions` — there is no `reducedMotion` member on
the test-options type. Writing the shorthand fails `just ci`'s `client-typecheck`
step with `TS2769: … 'reducedMotion' does not exist in type 'UseOptions<…>'`, and
even force-written past the type system it is a runtime no-op: the fixture that
promotes `use.*` keys into the real `browser.newContext()` call enumerates a
fixed allow-list that does not include it.

This is recorded because the failure mode is nastier than a compile error. An
implementer who hits TS2769 on the exact snippet the residual specified is
steered straight into this slice's named anti-pattern — a `page.emulateMedia({
reducedMotion: 'reduce' })` in a `beforeEach`, which compiles, makes the positive
test pass, and gates **nothing**, because it survives deleting the project
config entirely.

The spec therefore uses Playwright's built-in `page` fixture rather than a manual
`chromium.launch()` + `browser.newContext()` (rb-19's shape, forced on it by
`@axe-core/playwright` refusing a directly-created page). The fixture path is the
one that actually applies the active project's `use` options, and it gives each
test a fresh context — which is also what makes Decision 3's polarity flip safe
(see below).

## Decision 6 — the tier also runs per PR, and that is accepted, not overlooked

`client/package.json`'s `e2e` script is a bare `playwright test` with no
`--project`, and `.github/workflows/ci.yml`'s per-PR `e2e:` job runs `just e2e`.
Playwright runs **every** declared project when the CLI names none, so the moment
this config grows a `projects:` array the new spec runs on every PR as well as
nightly.

Accepted, for the same reasons ADR-0218 accepted it for `a11y.spec.ts` (whose
header records the identical double life): the spec needs no SpacetimeDB
connection, joins no player, has no RNG and costs ~2 s in a job that already has
a browser and a dev server. Suppressing it would mean a `--project=default`
neuter-shaped construct in the `e2e` recipe, which is more surface than the thing
it saves.

The consequence worth stating plainly, because "nightly-only" would otherwise be
read off the recipe: half 4's marginal contribution over the per-PR run is the
**floor** (a spec file that vanishes or is wholly `describe.skip`'d reports zero
tests and exits 0 — the shape measured below) and the nightly failure artifact.
It is not the only thing running these assertions.

## Consequences

- The repo gains its first browser-tier proof that a `@media` guard is actually
  evaluated, at ~2 s and zero RNG.
- `client/playwright.config.ts` gains a `projects:` array. Every future spec file
  is collected by the `default` project unless it is explicitly ignored — the
  two-sided `testMatch`/`testIgnore` pair is what keeps that safe, and
  `evals/ci-gate-wiring.eval.mjs` gates both sides. Measured: `--list` reports
  73 tests / 20 files before, and 73/20 for `--project=default` plus 2 for the
  new project after, with `globalSetup` still running exactly once per invocation.
- `.github/workflows/nightly.yml`'s failure-evidence artifact gains half 4's
  report path. Without it a red in the new tier ships with nothing to look at —
  the exact gap that step's own comment says it exists to close.
- A11Y-27's renderer arm remains ungated in a browser and, more importantly,
  **unimplemented**. That is now a ledger `DEFER` with a resolvable target
  rather than an assumption.
- Two verbatim pins in `evals/ci-gate-wiring.eval.mjs` move in lockstep with this
  slice and were REGENERATED mechanically, never hand-typed:
  `A11Y_E2E_RECIPE_REGION` (the justfile recipe grew half 4 and an `rmfloor`
  parameter) and `A11Y_E2E_NIGHTLY_JOB_BLOCK` (the artifact `path:` list grew a
  line, and that list is inside the pinned job block). The second was not
  anticipated when D4 was written: adding a path to the artifact list is a job
  edit, so the nightly pin reds until it is re-derived.
- The nightly artifact clause added to `a11yNightlyJobIsWired` is
  UNCONDITIONAL — a job with no `actions/upload-artifact` step is rejected — so
  three pre-existing POSITIVE fixtures had to gain one. They deliberately use
  different YAML spellings (a `path: |` block list and an inline `path:` scalar),
  because a gate that understands only one spelling is defeated by rewriting into
  the other.
- MEASURED while bite-proofing, and worth stating because the transcribed design
  had it twice: a text gate over this recipe must check that a field is COMPARED,
  not that it is MENTIONED. Deleting `if (s.expected < floor)` leaves
  `console.log('... tests=' + s.expected)` behind, and deleting `|| s.skipped !== 0`
  leaves `console.error('... skipped=' + s.skipped)` behind — so substring tests
  for `.expected` and `skipped` both accept a hollowed half 4. The `skipped` one
  SURVIVED a first bite-proof pass against the real justfile while every inline
  fixture was green, because the fixtures were smaller than the real recipe.
