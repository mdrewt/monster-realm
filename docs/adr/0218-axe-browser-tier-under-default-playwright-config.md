# 0218 — The axe-core browser tier runs under the default Playwright config, so the nightly a11y gate takes a server dependency

**Status:** Accepted
**Date:** 2026-08-30
**Slice:** rb-19 (residual R-m23-s11-X10)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-ui
**Decision:** Run the axe tier as half 3 of `just a11y-e2e` under the EXISTING Playwright config, accepting the live-SpacetimeDB dependency it forces on the nightly job; gate it with a measured `passes` floor and a shrink-only `incomplete` ceiling.

---

## Context and problem statement

`M23-accessibility.spec.md` §5.7 ("CI vs nightly — DECIDED") named **"axe-core + Playwright"** as
`just a11y-e2e`'s payload and settled its placement: not in `just ci`, not in
`REQUIRED_JUST_STEPS`, run nightly, plus a cheap additive wiring check. What §5.7 did **not** do
was assign the work. No slice in the spec's own §4 table owned authoring
`client/e2e/a11y.spec.ts`, so m23-s11 shipped the recipe as a *seam* — an eval-roster pin and a
unit-tier floor — and made it print a `DEFERRED: axe-core …` banner every run so the gap could
never read as covered. `docs/a11y-manual-protocol.md` calls it what it is: "a genuine spec gap,
not a scoping choice". This slice fills it.

Three things had to be decided that §5.7 did not decide.

## Decision drivers

- **`client/playwright.config.ts` and `client/e2e/global-setup.ts` are outside this slice's
  `touches:`.** Whatever ships must work without editing either.
- A browser tier is only worth its cost if it applies a lens the existing gates *structurally*
  cannot. Re-running the source and JSDOM oracles in a browser would be a gate that can only fail
  when `just ci` already failed.
- A zero-violation assertion is also what a blank page, a page that threw during boot and a page
  that never connected all report. Non-vacuity is the whole problem with this kind of test.

## Decision 1 — the spec runs under the DEFAULT Playwright config, and the nightly job grows a server

`client/playwright.config.ts` declares `globalSetup: './e2e/global-setup.ts'`, which
unconditionally runs `spacetime publish --delete-data`. It has no env-driven early return, and
Playwright has no CLI flag that skips `globalSetup`. So for any spec under `client/e2e/`, a live
SpacetimeDB is not a design choice — it is a **precondition**.

The alternatives were all worse:

- A second config file with no `globalSetup` — outside `touches:`, and it collides head-on with
  sibling residual rb-20, which needs a `reducedMotion: 'reduce'` project in *this* config.
- Making `globalSetup` cheap by putting a stub `spacetime` on `PATH` — that is not a workaround,
  it is the U1 PATH-shim attack `evals/nightly-smoke-wiring.eval.mjs` exists to catch.
- Scanning synthetically-unhidden static shells instead of a connected client — it audits markup
  the test just wrote. This repo has already measured that failure mode twice (a `role="dialog"`
  literal in `index.html` made a `closest('[role="dialog"]')` predicate unconditionally true; the
  a11y unit suites prove presence, not announcement). Spec §5.6's own residual says the browser
  run is "the compensating control", and a control that only inspects its own fixtures is not one.

So the nightly `a11y-e2e` job gains the same SpacetimeDB provisioning `ci.yml`'s `e2e` job and
`nightly.yml`'s `smoke-republish` job already carry, plus `npx playwright install --with-deps
chromium`. It goes from two `run:` steps to seven.

**That widening is the cost, and it is paid for explicitly.** Six pre-gate shell steps, one of
which appends to `$GITHUB_PATH`, is a materially larger PATH-shim surface than one `npm ci`. The
countermeasure is the house remedy this repo already uses for the recipe body: a **verbatim pin**,
`A11Y_E2E_NIGHTLY_JOB_BLOCK`, against which the whole job block is compared byte for byte. A
blacklist of bad step shapes would not close it — sixteen CI-clean bypasses have beaten one such
blacklist here before. A verbatim pin is closable by construction: any edit reds the gate, and the
fix is to regenerate the constant in the same commit, deliberately.

`MR_DEV_MODULE_WASM` is deliberately NOT set for this job. It exists to publish a
`--features dev_reducers` build; the axe tier needs no dev reducers, so the plain
`--module-path` publish is correct and one fewer moving part.

## Decision 2 — the spec is left in the per-PR `just e2e` pickup

`playwright.config.ts` has `testDir: './e2e'`, so `client/e2e/a11y.spec.ts` is also collected by
`just e2e`, which the **per-PR** `e2e:` job in `ci.yml` runs. That job is already non-hermetic and
fully provisioned, the three tests cost ~3 s, and the result is a per-PR a11y oracle for free.

Excluding it would mean adding `--grep-invert` to the `e2e:` recipe — shipping a neuter-shaped
construct into the one recipe that has none, which every future reader must take on trust. That
trade is bad. §5.7's constraint is on the **hermetic** gate `just ci`, and that constraint is
untouched: `REQUIRED_JUST_STEPS` is byte-identical to master's and `a11y-e2e` is not a `ci:`
dependency, transitively or otherwise.

That last sentence used to be a *convention*, and red-team demonstrated the cost of leaving it
one: appending `a11y-e2e` to the justfile's `ci:` dependency line, or adding a bare
`- run: just a11y-e2e` step to `ci.yml`, took the entire eval suite green. `a11yStaysNightlyOnly`
now asserts it across all three doors — the roster, the `ci:` dependency **closure** (transitive,
because `ci: … coverage` where `coverage: a11y-e2e` needs no `ci:` edit at all), and `ci.yml`.

## Decision 3 — measured floors and a shrink-only ceiling, not a known-violation allowlist

The plan carried a fallback: if the shipped client were dirty under axe, ship a ratchet of known
violations, since `client/index.html` and `client/src/**` are outside `touches:` and could not be
fixed here. **It was measured first rather than assumed.** Against a real Chromium and a real
published module, twice, byte-identical both runs:

| state | passes | violations | incomplete |
|---|---|---|---|
| connected world chrome | 16 | 0 | `color-contrast`, 2 nodes |
| help overlay open (`?`) | 21 | 0 | `color-contrast`, 23 nodes |
| menu overlay open (`M`) | 23 | 0 | `color-contrast`, 9 nodes |

The client is clean at WCAG 2.x A/AA today, so **no allowlist ships**. An allowlist with nothing
in it is a decoration that rots into a blanket exemption the first time someone needs one.

What does ship, per state:

- `violations` must be empty — the actual claim.
- `passes.length >= floor` (14/18/20, two below each measurement) — the **non-vacuity** device.
  A page that failed to boot evaluates ~0 rules and would otherwise report a clean scan.
- `results.testEngine.name === 'axe-core'` and `results.url` contains `localhost` — the results
  came from a real axe run against the real origin, not from a stub.
- the `incomplete` **id set** is closed to `{color-contrast}`: a new undecidable rule is signal.
- the `incomplete` **node count** is a per-state ceiling (2/23/9) that shrinks and never grows.
  Those nodes are text over the game `<canvas>`, whose contrast is not computable from the DOM —
  in the world state exactly `#build-stamp` and `#help-hint` (`client/index.html:124`, `:138`).
  There is no shipped contrast oracle covering them: `evals/contrast-ratio.eval.mjs` and its
  `baselines/contrast-unresolved.json` were specified but never landed, and remain the open
  residual **rb-14** (ADR-0216 records that they did not ship). That makes the ceiling MORE
  load-bearing, not less — until rb-14 lands it is the only thing in the repo that notices the
  undecidable set growing.

`best-practice` is excluded from the tag list and `canvas` from the scan root. Both are scope, not
convenience: §5.6 claims WCAG 2.2 Level AA and places the canvas outside it explicitly (it is
covered by the live-region text mirror as an alternate version). A gate that reds on advice trains
people to ignore it.

## Consequences

- The nightly `a11y-e2e` job roughly doubles in wall clock (a server-module publish dominates;
  the `v1-a11y` rust-cache absorbs it after the first run). Nobody waits on nightly.
- A SpacetimeDB or Chromium provisioning failure now reds an *accessibility* gate. The failure
  policy is unchanged (`docs/nightly-red-response-policy.md`), and the recipe's `A11Y-AXE OK` /
  `A11Y-NIGHTLY OK` verdict lines distinguish an infrastructure death from a real regression.
- `just a11y-e2e` can no longer be run locally without a live spacetime. Half 1 and half 2 still
  run first, so a developer sees those verdicts before half 3 fails.
- rb-20 (residual R-m23-s11-X11, not yet built) adds a `reducedMotion: 'reduce'` Playwright
  project. This slice touches `playwright.config.ts` zero times, so rb-20 is unblocked — but its
  new project will collect `e2e/a11y.spec.ts` too, and it should decide deliberately whether it
  wants an axe scan under reduced motion or a `testIgnore`.
- `docs/a11y-manual-protocol.md` still describes the axe tier as a gap. It is outside this slice's
  `touches:` and nothing gates agent-facing doc truth, so it is flagged as a residual rather than
  silently left to rot.
