# 0196 — Changelog freshness: the nightly check ADR-0165 deferred, as a lag×age conjunction

**Status:** Accepted
**Date:** 2026-08-15
**Slice:** 13r-g
**Supersedes:** —
**Amends:** ADR-0165
**Subsystems:** tooling-docs, ci-gates
**Decision:** Implement ADR-0165's nightly changelog check as an entry-multiset comparison of a fresh `git cliff` generation against the committed ledger, failing only when >= 15 entries are missing AND the oldest is >= 6 days old; advisory from 8.

## Context

ADR-0165 (Accepted 2026-07-31, slice 11r-d) chose a **nightly** changelog-freshness drift
check over a per-PR gate and over manual-only discipline, and deferred implementation to
slice **11r-i** because `.github/workflows/nightly.yml` and `scripts/` were outside 11r-d's
declared `touches:`. **11r-i never implemented it.** One milestone after 12r-f reconciled
the ledger, `CHANGELOG.md` had re-drifted **18 PRs / 34 entries** (measured at `7eb6980`, this slice's branch point) behind master — the third
episode of the same drift ADR-0165 was written about, and the second since the policy was
recorded.

13r-g closes it: `scripts/changelog-freshness.mjs` + `scripts/changelog-freshness.test.mjs`,
a `changelog-freshness` job in `.github/workflows/nightly.yml`, a regenerated ledger (34
entries, PRs #290–#326, a pure append), and the root-orphan `m13.5r-plan.md` relocated into
`docs/specs/`.

**ADR-0165's text is retired by this ADR, not edited in place.** Two statements there are now
false and are corrected here: its Consequences line *"No enforcement exists yet; drift can
recur until 11r-i lands the check"* (enforcement now exists; it landed in 13r-g, not 11r-i),
and its recommendation that the follow-up land in **11r-i**. Its D-shape sketch ("run `just
changelog` into a temp file and diff it against the committed `CHANGELOG.md`") is refined by
D1 below. Its named subtlety — `filter_unconventional = true` must not read as drift — is
preserved, structurally (D4).

## Decision

### D1 — Entry-set comparison, not the byte diff ADR-0165 sketched

The comparison is over the **multiset of `- ` entries, keyed by their enclosing `### `
group**, in `parseChangelogEntries` / `classifyChangelogDrift`. Three reasons, in order of
force:

- **Byte equality is red-by-construction.** The regen commit cannot contain its own entry, so
  `missing === 0` is structurally unreachable at a regen commit. Verified across **all 23
  commits that touch `CHANGELOG.md` on master**: every one has `missing >= 1` (twelve of the
  fifteen modern ones sit at exactly 1; one is at 5, where four direct-to-master commits landed
  between the branch regen and the merge). A byte-diff gate would be permanently red on a
  perfectly reconciled ledger.
- **Only a count can express the existing policy.** ARCHITECTURE.md m17.5g grants a lag of up
  to one open milestone. That tolerance is a quantity; a byte diff is a boolean.
- **A multiset, not a set.** 25 real entries carry no `(#NNN)` suffix and can render
  byte-identically within one group; a `Set` would under-count the lag.

Byte equality survives as a **tiebreak**: identical entry multisets but a different rendered
file is reported as verdict `rendering` (exit 1) — the only thing an entry-set-only
comparator would miss.

### D2 — The failure rule is a CONJUNCTION, not a threshold (the load-bearing decision)

The thresholds were **derived from the real signal, not chosen**: `git cliff` was run at each
of the last 150 master commits and diffed against that commit's committed `CHANGELOG.md`,
collapsed to one value per calendar night. `missing` over 2026-07-15..2026-08-15 (32 nights):

```
1, 3, 12, 22, 11, 19, 24, 26, 26, 4, 17, 18, 23, 23, 23, 25, 8,
14, 15, 15, 17, 20, 21, 4, 12, 18, 20, 20, 20, 21, 33, 34
```

The drift is a **weekly sawtooth**: it reaches 20–26 on a perfectly HEALTHY wave and resets to
1–8 at the milestone-close regen. No single count separates a healthy wave from rot:

| Candidate rule | Nights red (of 32) | Verdict |
|---|---|---|
| byte equality | 32 | permanently red (D1) |
| `missing > 15` | 21 (66%) | nag-then-bypass |
| `missing > 25` (planner's first proposal) | 4 | misses the 20–24 episodes, i.e. half the real ones |
| age only (`oldest >= 6d`) | 5 | fires on exactly the same 5 nights as the conjunction |
| **`missing >= 15` AND `oldest >= 6d`** | **5** (07-30, 08-06, 08-13, 08-14, 08-15) | **chosen** |

**Honest reading of that table:** on this 32-night series the **age arm alone is the entire
discriminator** — the count arm never changes a verdict, so the conjunction and age-only are
empirically indistinguishable here. The count arm is kept as **defence-in-depth, not as a
discriminator**: it is the only thing that still fails a ledger hundreds of entries behind if
the age signal is ever wrong (a clock defect, a rotted subject→entry transform, a rebase that
rewrites committer dates), and the age arm is the one that fails OPEN by design when it cannot
date the lag. Two independent arms, each covering the other's failure mode, is the reason to
prefer the conjunction over age-only — not a difference in observed firing.

A 66%-red nightly is the documented failure mode of this repo's nightly channel: ADR-0183
records `mutation-server` red **five consecutive nights, unnoticed**, with no notification
wiring — and it is the same nag-then-bypass mode ADR-0165 rejected the per-PR gate for. The
conjunction fires ~one night of lead time per wave and then stays red only while the wave
remains unreconciled, which is the actual pathology.

An **advisory** (verdict `lagging`, exit **0**) prints from `missing >= 8`, so the nightly log
shows the wave building rather than only its failure.

`LAG_FAIL_ENTRIES = 15`, `LAG_FAIL_AGE_DAYS = 6`, `LAG_WARN_ENTRIES = 8`. **Lowering either
is safe; raising either one requires amending this ADR.**

### D3 — Age comes from the oldest missing entry's commit date, never file mtime

`oldestMissingAgeDays` maps each missing entry's text back to a commit via the exported
`entryTextForSubject` transform and takes the oldest `%cI`. Two rejected sources, both
silent-green generators:

- **`statSync('CHANGELOG.md').mtimeMs`** — in a fresh `actions/checkout` every file's mtime is
  the checkout time, so the age is always ~0 and the AND-arm never fires: permanently,
  silently green.
- **`git log -1 --format=%cI -- CHANGELOG.md`** — reset by any cosmetic touch of the file.

The transform was verified to reproduce git-cliff **exactly** at `origin/master@7eb6980`:
**341 of 341** generated entries map back to a `git log --format=%s` subject, and the 7
unmapped subjects are precisely the ones git-cliff itself reports as skipped. The clock is
**injected** (`nowMs`) per the determinism invariant — there is no `Date.now()` in the pure
core.

### D4 — `filter_unconventional = true` is handled structurally, not by a carve-out

Both sides of the comparison are **git-cliff output** (a fresh generation vs the committed
generation), so a commit git-cliff skips is absent from **BOTH** and can never read as drift.
That is why the design is generated-vs-committed rather than git-log-vs-committed, and it
satisfies ADR-0165's named subtlety without a filter list that could rot.

**Honest limitation, recorded rather than buried:** a slice whose squash subject is not a
Conventional Commit produces no entry at all, on either side — so this counter **structurally
cannot see** that class of staleness.

### D5 — A small `extra` is an advisory; only a large one is a red

`extra` = committed entries not reproducible from history. A regen run at a **branch TIP**
bakes local commit subjects that the squash-merge then rewrites. That has already happened
once here: commit `34250d5` (M8.95d, 2026-07-04) committed

```
- ARCHITECTURE.md + ADR-0080 knowledge bundle doc
```

where a fresh generation yields `- ARCHITECTURE.md + ADR-0080 + CHANGELOG — closes M8.95
knowledge-bundle milestone (#105)`.

Making `extra > 0` an unconditional red would have produced an **unactionable nightly failure
with a misleading diagnosis**, and the predictable fix ("tolerate extra") would have re-opened
the vacuous greens that `extra` is the accidental sole defense for. So: `extra <= 3`
(`EXTRA_HARD_FLOOR`) prints a self-diagnosing advisory naming the branch-tip-regen signature;
`extra > 3` is verdict `drift` and fails — a `cliff.toml` template edit or a git-cliff version
change flips hundreds at once, which is the shape worth a red.

**Why the floor is 3 and not 1** — measured `extra` at every CHANGELOG-touching commit on
master: `b6363dc` (2026-07-10) had **exactly 3**; `74f9dbe` had 2, persisting across **eight
consecutive commits**; `5188db2` and `34250d5` had 1. A floor of 1 red-lines three of those
episodes and a floor of 2 red-lines `b6363dc` — all of them legitimate branch-tip regens, none
of them the pathology. 3 is the tight, evidence-backed value, not a round number.

**Consequence, stated plainly: a hand-edit of ≤ 3 entries is now invisible to this gate.**
The exposure is narrower than it first reads: only pure *additions* are durable. A rewrite or
a deletion plants a permanently-old entry in the `missing` set, so the first night the wave
reaches 15 the age arm reports that old date and reds — and `formatVerdict` prints each
offending entry verbatim (`not-in-history: …`) either way.

Correspondingly, **ordering is load-bearing** — the regen must be the FIRST commit on a branch,
and nothing after it may be regenerated.

### D6 — Environment guards precede any verdict, all exiting 2

An adversarial pass ran the *wrong* implementations against real repo data and showed that the
two highest-value vacuous greens are **shell defects invisible to any comparator fixture**:
reading the "generated" side from `CHANGELOG.md` (self-compare) is **GREEN on a genuinely
34-entries-stale ledger under every comparator variant**, and a swallowed `git cliff` error
gives an empty generation, i.e. "nothing missing". Guards, in order, all exit **2**
(environment, never a freshness verdict):

| Guard | Kills |
|---|---|
| `git rev-parse --is-shallow-repository` must be `false` | a `--depth 1` checkout: git-cliff emits ONE entry, exit 0, no warning (verified) |
| generation must contain >= 341 entries (`MIN_GENERATED_ENTRIES`) | truncation, a swallowed generator error, an absent git-cliff — history is append-only, so the floor can only be crossed downward by breakage |
| the newest Conventional Commit on HEAD must appear in the generation | **self-compare** — a stale committed file cannot contain the newest subject's entry |
| >= 90% of generated entries must map through `entryTextForSubject` (`MIN_MAPPED_FRACTION`) | a silently-rotted transform, which would make `ageDays` `null` every night and `stale` unreachable (D3's failure class by another route) |
| committed file contains no line outside {blank, `# Changelog`, `### ` heading, `- ` entry}, and no entry before the first heading | a file this script cannot reason about being scored as fresh |
| no `readFileSync` / `execFileSync` error is ever swallowed to `''` | the single most dangerous vacuous green: an empty "generated" side means zero missing |

Exit codes follow the house convention (`scripts/adr-digest.mjs`): **0** fresh or advisory,
**1** drift the ledger owner must fix, **2** environment / the script cannot trust itself. An
unknown verdict maps to 2, never to a pass.

### D7 — Teeth, and where they run

**`just ci` CANNOT run this check.** `justfile` and `evals/**` are outside 13r-g's declared
`touches:`, so no recipe and no eval could be added; under the supervised build loop an edit
outside the declared set is a hidden-dependency STOP (the same constraint that deferred
ADR-0165 in the first place). The check is executed **only** by the new nightly job.
Compensating measures, all inside the touch set:

- a **15-case inline fixture table** runs through the comparator on **every invocation**,
  before any file or subprocess I/O, and exits 2 if a tooth fails to bite. Each case names the
  wrong implementation it kills (byte-diff comparator, swallowed generation, bare count, age
  only, `>` vs `>=`, `Set` vs multiset, dropped `extra` branch, verdict precedence, …);
- the comparator is **injected** into `runSelfTest(classify)`, so the gating suite can prove
  the teeth bite by feeding a deliberately wrong comparator. Without that seam,
  `return { ok: true, failures: [] }` is an undetectable neutering of the whole table — it was
  a surviving mutant until the seam was added;
- a **72-test sibling suite** (`scripts/changelog-freshness.test.mjs`) runs as the nightly
  job's **first** step, in its own `run:` step (never `;`-joined, which would report only the
  last exit status);
- because **`node --test <file>` EXITS 0 WHEN THE FILE DEFINES ZERO TESTS** (verified on node
  24.13.1: it counts the file itself as one passing test), the script itself counts the sibling
  suite's tests and exits 2 below a floor of **50** (`MIN_SIBLING_TESTS`; committed count 72 —
  a floor, not an equality pin). This is the same countermeasure
  `evals/observability-stack-config.eval.mjs:334-349` documents for globbed test discovery,
  relocated into the script because `evals/**` was out of touches.

**Bite-proofed by mutation:** 15 mutations applied to a copy of the checker, **all 15 killed**
— the 15th only after the injection seam above was added. An adversarial second pass then showed
that the *shell* has no such coverage: 18 shell mutations all ship suite-green, because the suite
imports only pure functions. One of them was not malice but the obvious refactor — dropping
`ageDays` from a second `classifyChangelogDrift` call — so the bait was removed structurally
(`diffChangelogEntries` lets `main()` diff once, date the lag, then classify once). The residual
shell-mutation exposure is recorded as follow-up (4).

### D8 — git-cliff is version-pinned in the workflow

`taiki-e/install-action` with `tool: git-cliff@2.13.1` — the exact version that generated the
committed ledger. An unpinned `latest` would let an upstream rendering change flip every entry
to missing+extra at once and red the job for a reason unrelated to freshness.

## Consequences

- **Positive:** the check ADR-0165 decided on exists and runs; the drift that recurred twice
  now has a measurement; the failure signal was derived from 32 nights of the real series
  rather than picked; the whole vacuous-green family (shallow checkout, swallowed generator,
  self-compare, emptied test file, rotted transform) fails **closed at exit 2** rather than
  reporting freshness.
- **Zero per-PR coverage.** Biome (via `just lint`) does parse both new files, so a **syntax**
  error still reds `just ci`; a **runtime** error lands green and surfaces only at 07:00 UTC.
- **The new nightly job has no wiring guard.** `evals/nightly-smoke-wiring.eval.mjs` calls its
  neutering and failure-policy checks with **hard-coded job names** (`mutation`,
  `mutation-server`, `coverage`) and nothing iterates jobs — so deleting `changelog-freshness`
  or adding `continue-on-error: true` to it is invisible to `just ci` **forever**.
- **The thresholds are a convention, not a mechanical ratchet.** Pinning them would take an
  eval, and `evals/**` was out of touches. Lowering them is safe; raising either one requires
  amending this ADR.
- **Recipe duplication.** The script calls `git cliff` directly, duplicating the `just
  changelog` recipe body (`justfile:172`). A `cliff.toml` change is picked up by both; a
  **recipe** change is not.
- **A hand-edit of ≤ 3 entries is invisible** (D5), and non-Conventional-Commit staleness is
  structurally invisible (D4).
- **Nightly has no notification wiring at all** (ADR-0183). This signal lands in a channel with
  a documented history of going unread; the job carries a failure-policy comment in the
  ADR-0183 D5 shape, which documents a policy but notifies no one.

**Named follow-ups** — all blocked on a slice whose `touches:` include `evals/` or `justfile`:

1. **Move** (not duplicate) the gating into `evals/changelog-freshness-teeth.eval.mjs`,
   importing the pure comparator + the fixture table, so `just ci` catches comparator rot
   per-PR and pins the thresholds cross-directory. Duplicating it would leave two copies of the
   same fixtures to drift apart.
2. A `just changelog-check` recipe — and, its real motivation, a `just changelog` that **pins
   the git-cliff version**. Today the workflow pins `git-cliff@2.13.1` on the *reader* while
   `justfile:172` runs whatever version the developer has installed; a regen from a different
   version reds the nightly as `rendering`/`drift`, and the remedy string ("run `just
   changelog`") would reproduce the mismatch rather than fix it.
3. Extend `nightly-smoke-wiring`'s guarded-job list to include `changelog-freshness`.
4. **Shell coverage.** The sibling suite imports only pure functions, so all 18 shell mutations
   tried against it ship suite-green (`main()` neutered, guards reordered after the verdict,
   the exit downgraded). The refactor-shaped one was removed structurally (D7); the rest need
   deliberate malice, but the honest state is that `main()` has no automated coverage. A
   subprocess smoke test — run the script against two inline fixture repos and assert the exit
   codes — is the fix, and it belongs in the eval of follow-up (1).

## Confirmation

- `.github/workflows/nightly.yml` job `changelog-freshness` (07:00 UTC): `fetch-depth: 0`,
  `git-cliff@2.13.1`, then `node --test scripts/changelog-freshness.test.mjs`, then
  `node scripts/changelog-freshness.mjs --check`.
- `scripts/changelog-freshness.mjs` — the 15-case self-test runs before any I/O on every
  invocation and exits 2 on a failed tooth or a shrunken table; the two D7 self-integrity floors run first, then D6's five environment
  guards, all before any verdict; `scripts/changelog-freshness.test.mjs` (72 tests) is counted against a floor of 50, and the workflow additionally asserts the runner's own TAP `# pass` count (>= 50, `# fail 0`) — the `MIN_SIBLING_TESTS` marker is textual, and a block comment containing 60 `it(` occurrences satisfies it with zero real tests.
- **Acceptance checkpoint:** WHEN the ledger is >= 15 entries behind AND the oldest missing
  entry is >= 6 days old, the nightly `changelog-freshness` job fails and is triaged per its
  documented failure policy within one nightly cycle.

## References

- **ADR-0165** — the deferred decision this implements and forward-amends: its nightly-vs-per-PR
  choice stands; its "no enforcement exists yet / 11r-i" Consequences line and its 11r-i
  recommendation are retired here (landed in 13r-g); its byte-diff shape is refined by D1; its
  `filter_unconventional` subtlety is satisfied by D4.
- **ADR-0142 D1** — the git-cliff SSOT and the regen-on-close cadence ADR-0165 closed.
- **ADR-0183** — nightly `mutation-server` red five consecutive nights with no notification
  wiring: the empirical case for D2's conjunction, and the source of the per-job
  failure-policy-comment shape used by this job.
- **ADR-0050** — the precedent for non-blocking nightly drift gates.
- **ADR-0010** — proof-of-teeth, the bar D7's fixture table and mutation run answer to.
- `ARCHITECTURE.md` m17.5g — the "at most one open milestone" lag policy this check measures.
- Threshold provenance: `git cliff` replayed at the last 150 master commits, series measured
  2026-08-15; generation floor and transform fidelity measured at `origin/master@7eb6980`
  (341/341); branch-tip-regen signature at commit `34250d5` (2026-07-04).

## Update — 16r-c (2026-08-22)

Follow-ups **#3** and **#2** land; **#1** and **#4** remain deferred.

**#3 done:** `evals/nightly-smoke-wiring.eval.mjs` gained six real checks (24-30) over the
`changelog-freshness` job: structure-unambiguous, workflow-scope-neuter-free, job declared, not
neutered (against a verbatim gate pin), documents its failure policy, git-cliff pins agree, and
the `changelog-check:` recipe body is intact. `jobIsNotNeutered` gained an additive
`opts.gates` array of DATA descriptors (default `[{kind:'just'}]`, byte-equivalent to prior
behavior); `CHANGELOG_FRESHNESS_GATES` pins the job's two gate steps (the TAP gating suite,
`node scripts/changelog-freshness.mjs --check`) verbatim and in order. 43 tester-authored teeth
(V0-V28, W1-W15) plus 9 orchestrator-authored round-2 teeth (V29-V34, W16-W17). All three EARS
neuter modes proven RED end-to-end against a copy of the real workflow: `continue-on-error` →
Check 27; removal from `notify`'s `needs:` fan-in → the pre-existing Check 21; whole-job
deletion → the new Check 26.

**#2 done:** `justfile` gained `GIT_CLIFF_VERSION := "2.13.1"` and a `#!/usr/bin/env bash`
`changelog:` recipe that asserts `git cliff --version` matches the pin before writing a byte,
plus a sibling `changelog-check:`. Pinned three ways (justfile variable, the workflow's
`tool: git-cliff@2.13.1`, the eval's `GIT_CLIFF_PINNED_VERSION`) in the `justfileCapEqualsCeiling`
shape. `changelog-check` is deliberately NOT in `just ci` — the nightly-not-per-PR decision (D7)
stands; adding it to `just ci` would need a matching `ci.yml` step per
`evals/ci-gate-wiring.eval.mjs`, out of scope for this slice.

**Recipe hardening, measured not theoretical:** git-cliff gives every CLI option an environment
twin, so a genuine pinned binary renders an attacker's template with `GIT_CLIFF_CONFIG` set and
a version-only assertion satisfied; and `git cliff -o CHANGELOG.md` truncates the target before
rendering, so a template error destroys the committed ledger. The pinned recipe body scrubs
`GIT_CLIFF_*`, passes `--config cliff.toml` explicitly, and renders to a temp file it `mv`s only
on success.

**Three pre-existing BLOCKER-class holes closed in passing** (each affects `mutation`,
`mutation-server`, and `coverage` too, not just this job): a job-level `defaults: run: shell:`
no-ops every run step while pinned `run:` text stays intact — a third neuter scope the
workflow-scope and step-scope rules each half-covered; `strictJobBlock` scanned from line 0, so
a decoy job block parked inside a top-level `run-name:` block scalar won the first-match race
against the real, `if: false`-carrying definition; `justRecipeBody` was first-wins, so a just
`'''` string literal holding the pinned recipe body verbatim could sit above the real, tampered
`changelog:` recipe. Also now rejected: `working-directory:` on a gate step, and a folded
(`run: >`) block scalar.

**Regression introduced and fixed in-slice:** round 1 widened the `{kind:'just'}` matcher to
read block-scalar bodies, which loosened the pre-existing gate — a `run: |` gate step, previously
fail-closed, became satisfiable by a body merely starting with `just`. Fixed by requiring
single-line run text for that kind; tooth V29 pins it.

**#1 and #4 remain deferred**, dated 2026-08-22: both require exporting the pure comparator and
fixture table out of `scripts/changelog-freshness.mjs`, and `scripts/**` was outside 16r-c's
declared `touches:` (#4 is downstream of #1 by this ADR's own wording). Unchanged by 16r-c:
`main()` still has no automated coverage, and comparator rot is still caught only at 07:00 UTC.
Next carrier: the next slice whose `touches:` include both `scripts/` and `evals/`.

**Named residuals still open**, all measured live, all pre-existing and affecting every guarded
job, not unique to `changelog-freshness`: a `uses:` step can run arbitrary shell before the
gates (`actions/github-script` with a `with: script:` payload, or a local composite action) —
the "no shell before the gate" rule counts only `run:` steps; `env: NODE_OPTIONS: --require …`
on a gate step defeats both node gates, because the env scan is a PATH-only denylist (flipping
it to an allowlist is blocked in-slice by frozen tooth U2c, which pins that ordinary non-PATH
env keys are accepted — re-authoring that tooth is its own decision); a job-level
`strategy: matrix:` resolving to zero instances, and a job-level `needs:` that makes the job
skip when a sibling reds — `notify`'s `skipped` term is a partial runtime backstop for both, but
the static gate is blind; `runs-on:`/`container:` can relocate a guarded job onto an
attacker-chosen toolchain. Closing these needs a step-key / `uses:` / `env:` allowlist across
all guarded jobs — its own slice, with the U2c decision made deliberately.

**Accepted coupling cost, not a bug:** `just --unstable --fmt` would reformat
`{{GIT_CLIFF_VERSION}}` and RED the verbatim recipe pin; a git-cliff re-pin must move all three
sites (justfile, workflow, eval) in one commit.
