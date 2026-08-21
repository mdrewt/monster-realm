# 0201 — Wire the Tier-2 observability validator, and make the gate strict by default

**Status:** Accepted
**Date:** 2026-08-20
**Slice:** lp-05 (M-loop-infrastructure §lp-05)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, tooling-docs
**Decision:** The Tier-2 observability validator becomes a `ci:` dep run with `--require-docker`, so the gate fails instead of skipping when docker is absent; `summarize()` is fail-closed on unknown status.

## Context

Measured at `064e627`: `ops/observability/validate.mjs` had **zero programmatic callers**. The only
references anywhere in the repo were its own usage comment at `:12` and three lines in
`ops/observability/README.md` (`:52`, `:117`, `:122`). Neither the `justfile` nor
`.github/workflows/ci.yml` contained the string `observability` at all.

That is the whole defect. The file is a *good* validator — it runs each upstream config validator
through the pinned image the stack actually deploys, and `ARCHITECTURE.md:1430` records that this is
how a real bug was caught (Tempo 3.0.x restructured `app.Config` and dropped the top-level
`compactor` key that D11's `block_retention` needs, which is why Tempo alone is pinned to the 2.x
LTS track). It simply never ran anywhere except by hand.

Tier 1 (`ops/observability/checks/stack-config-checks.mjs`, 18 pure text predicates) *is* wired,
through `evals/observability-stack-config.eval.mjs` → `just eval` → `ci:`. Tier 2 is its complement,
and the complement was dark.

The file's own docstring at `:5-7` states the design intent that this slice completes:

> Every check is skip-guarded: if docker is absent the check reports `skipped` explicitly and
> loudly. It NEVER silently passes — a skip and a pass are different words here on purpose.

Correct for a laptop. Wrong for a gate — a gate that reports `skipped` and exits 0 is a gate that
passes while checking nothing.

## Decision

### 1. One recipe, invoked strictly, as a `ci:` dep

```
observability-validate:
    node ops/observability/validate.mjs --require-docker
```

added to the `ci:` dep list, with the matching exact step in `.github/workflows/ci.yml`'s `ci:` job.

**Why a `ci:` dep and not a recipe body line — this is the load-bearing choice.**
`evals/ci-gate-wiring.eval.mjs::justfileCiDepsAppearInCi` (`:257-331`) iterates every dep on the
`ci:` header line and requires an **exactly** trimmed `- run: just <dep>` step to exist in ci.yml's
`ci:` job block. That predicate is the only free wiring enforcement available to this slice, and it
is genuinely non-self-sealing: it runs from three independent points — `lefthook.yml` pre-commit,
`just eval`, and a standalone `- run: node evals/ci-gate-wiring.eval.mjs` step in the `e2e:` job at
`ci.yml:117`. Measured against the real eval: dep-without-step **FAILS**, dep-plus-exact-step
**PASSES**, and the step neutered with `|| true` **FAILS**.

A body line on `ci:` was the original plan and was rejected: it is enforced by **nothing**. Applying
the whole slice to a copy of the tree and then deleting all three wiring lines left
`ci-gate-wiring`, `build-ci-hygiene`, `gate-teeth`, `gate-hardening-config` and
`observability-stack-config` all **PASS**. Zero trips.

**Why strict (`--require-docker`) in the recipe rather than the bare form.** The bare invocation is
the *expensive* one, not the cheap one — it pulls the same ~1.6 GB of pinned images and runs the same
`xcaddy build` either way. So a two-step "lax step then strict step" design (also considered) buys
nothing: the first step already pays the full cost. One recipe, strict, run once.

The consequence is deliberate and is stated here rather than discovered later: **`just ci` now
requires docker.** A docker-less machine cannot run the full gate. That is the correct reading of
this milestone's thesis — the gate is exactly the place where a skip must not be a pass — and the
laptop path is preserved as the bare `node ops/observability/validate.mjs`, which is what
`ops/observability/README.md:52` already documents and what EARS-3 pins.

**Why not the `e2e:` job** (the other placement considered, for the free neuter protection
`evals/e2e-desync-teeth.eval.mjs::e2eGateIsBlocking` gives that block): three reasons, all measured.
`docs/adr/0184-trade-negative-path-dynamic-suite.md:66-70` records that `e2e` is **not** a
branch-protection-required check — it is enforced by merge doctrine — so "put it where the required
check is" is void; `ci:` and `e2e:` are equally non-required. `ciStepsUnneutered` resolves
`REQUIRED_JUST_STEPS` against the **`ci:` job block only** (`:148`, `:204-218`), so a future slice
promoting this verb to that hardcoded oracle would *red* the eval if the step lived in `e2e:` — the
advertised one-string upgrade path only exists in `ci:`. And `e2e` is already the long job
(12m19s vs `ci`'s 5m13s on run 32089471235) with no `timeout-minutes`, whose recent master runs
died at the 6-hour ceiling.

### 2. `summarize()` is fail-closed in three directions

Extracted as a pure exported function — it is the only part of the file testable without docker, and
EARS-2/EARS-3 live in it.

1. **Status allowlist.** Any result whose `status` is not one of `pass`/`fail`/`skipped` fails the
   run. Without this the rules are a blacklist: a red-team pass measured `"Skipped"` (capital S),
   `"SKIPPED"`, `"skip"`, `"failed"`, `"error"` and `undefined` all exiting **0** under
   `--require-docker`. The capital-S case is the worst shape available here — the printer does
   `r.status.toUpperCase()`, so the log line reads `validate SKIPPED: all tool-backed checks` while
   the process exits 0 and nothing contradicts it.
2. **Any `skipped` while `--require-docker`** → exit 1, with the message naming the skipped labels.
   Generalised beyond the docker-absence result on purpose: today `validate.mjs:119-124` produces
   exactly one whole-suite skip so the generalisation is behaviourally identical, and the day a
   legitimately-skippable check appears, the failure names it and forces a deliberate decision
   rather than silently tolerating it.
3. **A non-vacuity floor.** `results.length < EXPECTED_MIN_CHECKS` (derived from `IMAGES`, not a
   second hand-maintained list) fails a run with no skips. This is what stops the check set
   shrinking: three cheating implementations were written against the pre-hardening teeth and all
   three passed 24/24 — one ran only `docker compose config` and gave the other six
   `status:'n/a'`, one gave them `status:'pass'`, and one kept all eight but pointed every image at
   `busybox:latest` and every config path at `/dev/null`. The floor plus the argv-recording tooth
   (below) kill all three.

The summary line at `:204` is also fixed: `validate.mjs: 1 check(s), 0 failed` read as a pass when
the one "check" was a skip.

### 3. `-f docker-compose.yml`, explicitly

`RENDER_ENV` spreads `process.env`, so `COMPOSE_FILE=harmless.yml` made `docker compose config`
validate a *different file* and exit 0 — measured. Passing the filename explicitly closes it at the
call site.

An `RENDER_ENV` allowlist was considered and **rejected**: dropping `DOCKER_HOST` from the child env
while `hasDocker()` still runs with the full `process.env` would make `hasDocker()` return true and
then every containerised check fail to reach a daemon — reddening the gate on rootless docker, a
remote context, or Docker Desktop, all of which work fine today. The one variable that mattered is
closed by `-f`.

### 4. Entry guard: `import.meta.main`

Not `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`. `scripts/changelog-freshness.mjs:691-697`
is this repo's SSOT for the identical situation and says why: `import.meta.url` is realpath-resolved
while `process.argv[1]` is not, so a symlinked invocation silently skips `main()` and exits 0. That
was reproduced here for a symlinked file, a symlinked *parent directory*, and `node --import`.
`justfile:1` sets `windows-shell`, so drive-letter/separator normalisation is a second false branch.

## Consequences

**Cost.** Warm (images pulled, caddy image built): **3.6 s** for all 8 checks, measured twice on this
machine. Cold, per CI run: ~1.6 GB of anonymous Docker Hub pulls (alloy 781 MB, prometheus 359 MB,
loki 208 MB, tempo 165 MB, caddy-alpine 89 MB) plus `ops/observability/Dockerfile:11`'s
`xcaddy build v2.11.4 --with github.com/mholt/caddy-ratelimit@v0.1.0`, a full Go compile measured at
39.7 s with base images already local. GitHub runners keep no persistent docker layer cache, so this
is paid every run. The `ci:` job is the short job (5m13s vs `e2e`'s 12m19s), so the added minutes
land off the critical path. **The measured delta from this slice's own PR run is recorded in the PR
body.**

**Known flake class, disclosed not mitigated.** `run()` returns `{status:'fail'}` for any non-zero
child exit, so a Docker Hub rate limit (exit 125) or a `proxy.golang.org` hiccup reds a merge-blocking
check with a message that reads like a config failure. Distinguishing exit 125 was considered and cut
as out of scope — the *verdict* is identical (RED either way) and only the message differs. The real
mitigations (an authenticated pull, a registry mirror, a warm-up step) are all outside this slice's
declared `touches:`. If this flakes, that is the follow-up — and note the failure mode to guard
against is a frustrated human deleting the step, which is precisely why §1 chose the placement that
makes deletion trip an eval.

**What `docker compose config` does and does not see.** Measured against the real compose file: it
catches YAML syntax errors, unknown top-level keys, unknown service keys, `depends_on` on a
nonexistent service, bad port syntax, and missing `:?`-required variables. It **does not** catch an
entire service being deleted, a volume source pointing at a nonexistent host file, a nonexistent
image tag, or a host port collision. Tier 1 owns service presence
(`checks/stack-config-checks.mjs`); the next reader should not assume Tier 2 covers it.

**Residuals** (each would require an edit outside this slice's declared `touches:`, so each is a
named follow-up rather than a silent gap):

- **The new suite has no pass floor from the shared mechanism.** `node --test` exits **0** on a
  zero-test file, a 0-byte file, an all-`skip` file, and even on a failing test followed by a
  top-level `process.exit(0)` — all measured on node 24.13.1. This slice puts a fail-closed
  `fail 0` + pass-floor wrapper in the `test:` recipe (the `mutate-core:` idiom at `justfile:69`)
  because the shared mechanism — adding the file to `NODE_TEST_FILES` and re-deriving
  `NODE_TEST_PASS_FLOOR` at `evals/observability-stack-config.eval.mjs:350-355` — is out of scope.
  Consolidating onto the shared floor is the follow-up; two floors is one more thing to re-derive.
- **The new ci.yml step's `if:`/`continue-on-error:` are not covered by the shared eval.**
  `ciStepsUnneutered` inspects step ranges only for the seven hardcoded `REQUIRED_JUST_STEPS`
  (`:31-39`). This slice's own teeth assert it, but the durable fix is one string in that oracle.
- **`ops/observability/README.md` is not updated.** It is outside `touches:`. Its documented bare
  invocation still works and still behaves as documented, so no doc-vs-code lie is introduced — but
  it will not mention the new `just` verb or the flag.
- **`ARCHITECTURE.md:1430`** (the m20b entry) says the observability stack has "nothing wired into
  `just ci`". That becomes false; the append-only slice log entry added by this slice supersedes it
  in words rather than editing history.

## Alternatives rejected

- **A `paths:`-filtered job**, matching EARS-1's "when the observability config changes" literally.
  A non-required path-filtered job cannot block a merge, so it would be a gate that cannot fail.
  EARS-1 is satisfied by the superset: the validator runs on every gate invocation.
- **Strictness from an env var** (`if (process.env.CI) requireDocker = true`). Makes ci.yml lie
  about what it runs — the exact false-green class this milestone exists to kill. Strictness is
  visible at the call site instead.
- **A `--config-root` option** to let a test point the validator at a scratch config tree. Its only
  consumer would be a docker-conditional test, which would reintroduce a skip into the suite that
  exists to kill skips. The malformed-compose bite is run as a recorded one-time drill instead.
- **`parseArgs` as a separate exported allowlist mechanism** for one boolean flag. Ceremony:
  rejecting `-r`, `--require-docker=false`, unknown flags and positionals all falls out of one
  equality inside `main(argv)`, which is exported and directly testable.
