# 0219 — The reduced-motion browser tier covers A11Y-27's stylesheet arm only, because the renderer arm was never wired into main.ts

**Status:** Accepted
**Date:** 2026-08-30
**Slice:** rb-20 (residual R-m23-s11-X11)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-ui
**Decision:** Add a `reducedMotion: 'reduce'` Playwright **project** whose `testMatch` collects exactly one new spec, gate it as half 4 of `just a11y-e2e`, and scope its claim to the stylesheet arm of A11Y-27 — because the renderer arm's `main.ts` wiring does not exist and cannot be added from this slice's `touches:`.

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
hardened by rb-17 at `client/src/styles.css:94-99`:

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

And the positive test runs **before any `emulateMedia` call in the file**. That
ordering is the whole gate: `page.emulateMedia({ reducedMotion: 'reduce' })`
inside the test would keep it green with `use: { reducedMotion: 'reduce' }`
deleted from the config, which is to say it would gate nothing.

## Decision 4 — half 4 of `just a11y-e2e`, nightly, with a `case`-guarded floor

The tier is wired where §5.7 put the rest of the a11y browser work rather than
into `just ci`: the nightly `a11y-e2e:` job already provisions chromium, Rust,
wasm-pack and a live SpacetimeDB, and `globalSetup` takes that server dependency
unconditionally (ADR-0218 D1). No new nightly job key is added — half 4 rides the
existing `- run: just a11y-e2e` step.

`--project=reduced-motion` on the invocation is load-bearing: without it the
recipe runs every e2e spec. The floor is read from the JSON report and never
from console text (a missing spec file reports zero tests and exits 0), and the
new `rmfloor` parameter is `case`-guarded as a non-negative integer for the
reason ADR-0183 D7 records: `Number('')` is `0` and `Number('abc')` is `NaN`,
and `expected < NaN` is `false`, so an empty or non-numeric floor prints OK on a
zero-test report.

## Consequences

- The repo gains its first browser-tier proof that a `@media` guard is actually
  evaluated, at ~2 s and zero RNG.
- `client/playwright.config.ts` gains a `projects:` array. Every future spec file
  is collected by the `default` project unless it is explicitly ignored — the
  two-sided `testMatch`/`testIgnore` pair is what keeps that safe, and
  `evals/ci-gate-wiring.eval.mjs` gates both sides.
- A11Y-27's renderer arm remains ungated in a browser and, more importantly,
  **unimplemented**. That is now a ledger `DEFER` with a resolvable target
  rather than an assumption.
