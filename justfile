set windows-shell := ["cmd.exe", "/c"]

# Integration-runtime isolation: the published db name is env-driven (default
# unchanged), aligned with the client's VITE_STDB_DB, so two concurrent local
# integration/e2e runs can set distinct VITE_STDB_DB (+ MR_E2E_PORT, see
# client/playwright.config.ts) and not collide on one db/port (one shared
# SpacetimeDB instance hosts both; distinct db names isolate their data).
db := env_var_or_default("VITE_STDB_DB", "monster-realm")
# The EXACT git-cliff that generated the committed CHANGELOG.md. Must stay equal to the
# `taiki-e/install-action` pin in `.github/workflows/nightly.yml`'s changelog-freshness
# job — `evals/nightly-smoke-wiring.eval.mjs` (gitCliffPinsAgree) fails the eval if the
# two ever disagree. See the `changelog:` recipe below for why.
GIT_CLIFF_VERSION := "2.13.1"
# monster-realm cargo workspace verbs. Pure logic is testable offline;
# build/publish/e2e need the spacetime CLI + an instance (see README).

setup:
    cargo fetch
    cd client && npm install --include=dev

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    client/node_modules/.bin/biome check .

typecheck:
    cargo check --workspace --all-targets

# Fail-closed wrapper around the Tier-2 observability gating suite (lp-05).
# WHY the wrapper: `node --test` exits 0 on a zero-test file, a 0-byte file, an
# all-`skip` file, and on a failing test followed by a top-level process.exit(0)
# — all four measured. So the exit code alone is not a verdict: the summary is
# parsed, an unparsed count is FATAL, `fail` must be 0, and `pass` must clear a
# floor. Node 24's DEFAULT reporter prints `ℹ pass N`, not the TAP `# pass N`,
# so both spellings are matched. `pipefail` is load-bearing: without it the
# `node --test ... | tee` pipeline reports tee's exit status. Mirrors the
# fail-closed idiom in `mutate-core` above.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo nextest run --workspace
    cargo test --doc --workspace
    out="$(mktemp)"
    node --test ops/observability/validate.test.mjs 2>&1 | tee "$out"
    pass="$(grep -Eo '^(ℹ|#) pass [0-9]+' "$out" | grep -Eo '[0-9]+$' | tail -1)"
    fail="$(grep -Eo '^(ℹ|#) fail [0-9]+' "$out" | grep -Eo '[0-9]+$' | tail -1)"
    if [ -z "$pass" ] || [ -z "$fail" ]; then
        echo "observability validate suite: could not parse the node --test summary" >&2
        exit 1
    fi
    if [ "$fail" -ne 0 ]; then
        echo "observability validate suite: $fail failing test(s)" >&2
        exit 1
    fi
    if [ "$pass" -lt 62 ]; then
        echo "observability validate suite: only $pass test(s) passed, floor is 62" >&2
        exit 1
    fi

eval:
    node evals/run.mjs
    just perf-budget

# The OBS-5/OBS-6 perf-budget gate (m20a, ADR-0180 D7): bench the 7 game-core
# hot paths with criterion and fail on any committed-ceiling breach (the
# comparison lives in game-core/benches/hot_paths.rs + budgets.rs).
# WHY it is wired inside `eval:` rather than as a `ci:` dependency:
# ci-gate-wiring.eval.mjs pins the `ci:` dep list against .github/workflows/
# ci.yml (every ci: dep must appear there as `- run: just <dep>`), and ci.yml
# is outside m20a's touches — while the `eval:` body is only required to
# CONTAIN `node evals/run.mjs`, extra lines being legal.
# The `rm -rf` is AM1's belt (in-process clean_ids is the suspenders): a
# rust-cache-restored target/ must never hand the gate a stale estimates.json.
# CRITERION_HOME is exported ABSOLUTE ($PWD fallback) because cargo runs the
# bench binary with cwd = game-core/, so a relative path would resolve to a
# different directory inside the bench than it does in this shell.
perf-budget:
    #!/usr/bin/env bash
    set -euo pipefail
    export CRITERION_HOME="${CARGO_TARGET_DIR:-$PWD/target}/criterion"
    rm -rf "$CRITERION_HOME"
    cargo bench -p game-core --bench hot_paths

# Build the client-prediction wasm pkg (--target bundler) the client imports +
# the e2e/typecheck consume. Gitignored; rebuilt from source (client-wasm).
wasm:
    wasm-pack build client-wasm --target bundler

security:
    node scripts/check-secrets.mjs .

mutate:
    cargo mutants --workspace

# Nightly mutation gate scoped to the rule core (ADR-0050). Narrower than
# `mutate` (--workspace) so the scheduled run stays tractable; the wrapper
# below provides: fail-closed guard on the missed.txt outcome file (vacuous-
# green V4 prevention), hard-zero missed count, and timeout tolerance
# (ADR-0088 §Decision 1-2). Runs in nightly.yml only.
mutate-core:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    cargo mutants -p game-core || status=$?
    # 0 = clean; 2 = missed mutants; 3 = timeouts (may accompany missed).
    # Anything else (1 usage, 4 baseline-test failure, ...) = fail loud.
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    # Fail closed if the outcome file is absent — wc -l would also fail
    # under set -euo pipefail, but the explicit guard gives a clearer message (V4).
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutants.out/missed.txt absent — cannot verify zero-missed" >&2
        exit 1
    fi
    missed=$(wc -l < mutants.out/missed.txt)
    echo "mutate-core: missed=$missed (zero-tolerance ADR-0050; timeouts tolerated iff missed=0, ADR-0088)"
    if [ "$missed" -gt 0 ]; then
        echo "game-core mutation gate: $missed surviving mutant(s) — zero-tolerance (ADR-0050)" >&2
        exit 1
    fi

# Nightly server-module mutation gate (ADR-0050 amendment A2, D-13.5-2). The cargo
# package for server-module/ is `monster-realm-module` (`-p server-module` fails
# "Package not found in source tree"). Survivor-count RATCHET, not zero-tolerance:
# the shell's reducers are covered by evals/integration/e2e rather than in-crate
# units, so surviving mutants are counted against a cap (baseline 324 missed of
# 753 mutants @ 14r-a, 2026-08-14, ADR-0183 re-baseline — the exact count the
# hosted nightly measured on three consecutive runs; the same tree measures 323
# locally, the one-mutant delta being a reducer-body mutant documented in
# ADR-0183. Prior baselines 299 @ m17.5a 2026-07-17, 308 @ m17a 2026-07-17, 309
# @ 908c99b 2026-07-15 per ADR-0118, 180 @ e875af0 2026-07-04) instead of failing
# on any survivor (game-core's mutate-core keeps zero-tolerance). This cap is
# DEBT-CARRYING: ADR-0183 names 11 in-crate-killable survivors whose kill slice
# must ratchet it to ≤313. `--test-tool nextest` is pinned for determinism with
# the recorded baseline (zero doctests in the crate, so catch results are
# identical).
# Cap bumps must update ADR-0050. Runs in nightly.yml only (mutation-server job);
# the recipe body is integrity-guarded by evals/nightly-smoke-wiring.eval.mjs,
# which also asserts this cap default EQUALS its MUTATE_SERVER_CAP_BASELINE.
mutate-server cap="324":
    #!/usr/bin/env bash
    set -euo pipefail
    # Fail loud on a non-integer cap BEFORE the (minutes-long) mutants run: a
    # malformed value would otherwise make `[ -gt ]` error inside the if-condition
    # and silently skip the ratchet (vacuous green) — caught by the cap bite-proof.
    case "{{cap}}" in
        ''|*[!0-9]*) echo "mutate-server: cap '{{cap}}' is not a non-negative integer" >&2; exit 64;;
    esac
    status=0
    cargo mutants -p monster-realm-module --test-tool nextest || status=$?
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
        echo "cargo mutants failed with exit $status (build/config error, not 'mutants missed')" >&2
        exit "$status"
    fi
    # missed.txt exists whenever cargo-mutants ran (exit 0 or 2). The explicit
    # existence guard is NOT redundant with set -e (ADR-0183 D7, proved by
    # execution): `|| true` swallows grep's exit 2, leaving missed="", and the
    # resulting `[ "" -gt N ]` error is EXEMPTED from set -e because it sits in
    # an if-condition — so without this guard the ratchet block is skipped and
    # the gate exits 0 vacuously green. Same fail-closed shape as mutate-core.
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutate-server: mutants.out/missed.txt absent — cannot verify the survivor count" >&2
        exit 1
    fi
    # grep -c '' counts lines regardless of a trailing newline (wc -l undercounts
    # a newline-less last line); || true keeps the empty-file (0 survivors) case
    # alive under set -e.
    missed=$(grep -c '' mutants.out/missed.txt || true)
    # Second belt: a non-numeric count would error inside the if-condition below
    # and be set -e-exempt exactly as above.
    case "$missed" in
        ''|*[!0-9]*) echo "mutate-server: survivor count '$missed' is not an integer" >&2; exit 1;;
    esac
    echo "surviving mutants: $missed (cap {{cap}})"
    if [ "$missed" -gt "{{cap}}" ]; then
        echo "survivor count $missed exceeds cap {{cap}} — mutation ratchet violated (ADR-0050)" >&2
        exit 1
    fi

# Nightly vitest line-coverage gate (ADR-0050). Self-contained: installs the
# coverage provider via --no-save at the EXACT version of the installed vitest,
# derived at run time (vitest's peer dep requires an exact-match provider, so a
# hardcoded pin silently rots on a vitest bump — precisely how the m8.5c `@2.1.9`
# pin broke on the intentional v4 upgrade; deriving keeps ONE source of truth,
# ADR-0050 amendment 2026-07-22). Still touches NEITHER client/package.json, the
# lockfile, nor vite.config.ts (M8.5d domain). POSIX command substitution —
# nightly runs on Linux.
# vitest exits non-zero if line coverage falls below the threshold. Runs in
# nightly.yml only — NOT part of `just ci` (preserves the ADR-0043 fast loop).
# Threshold 96: re-measured post-exclusion at 99.35% lines and ratcheted from the
# stale 25 (set from a 29.65% pre-exclusion denominator) — ADR-0050 amendment A1.
# Under vitest 4 (AST-aware v8) re-measured at 97.56% lines; re-measured again at
# 98.22% once `: wasm` below let the main.ts-importing specs actually run
# (2026-08-27) — still >96 either way.
#
# `: wasm` is load-bearing, for the SAME reason spelled out at the `a11y-e2e`
# recipe below: client/src/main.a11yFocus.test.ts and main.battle-reseed.test.ts
# import main.ts, which imports ../../client-wasm/pkg/client_wasm.js. Without a
# prebuilt pkg those 36 tests fail to RESOLVE (not to assert) — and vitest emits
# NO coverage report at all when any test fails, so the threshold is never
# evaluated. That is how this gate ran red-but-UNENFORCED for four nights
# (#362/#372/#374/#375). The nightly `coverage:` job provisions Rust + wasm-pack
# precisely to satisfy this dependency; evals/nightly-coverage-wasm-wiring.eval.mjs
# gates both halves, and that it is a PRIOR dependency (`coverage: && wasm` would
# run vitest first and is indistinguishable in `just --dump` except by `priors`).
coverage: wasm
    # Runtime backstop for the `: wasm` dependency above. Every gate that asserts that
    # dependency does so by reading the recipe GRAPH, and a graph is forgeable: a
    # parameterized `wasm`, a just-conditional body (whose dump carries BOTH branches),
    # a leading `-` ignore-failure prefix, a `#!/bin/true` shebang and a step-level env
    # guard were each MEASURED green against a text oracle while building nothing. This
    # line checks the artifact client/src/main.ts actually imports, so any such cheat
    # dies here, loudly, instead of silently running vitest against a missing pkg and
    # reporting 36 unresolved-import failures as if they were real test regressions.
    # NB: no double-brace sequence in this comment — just parses interpolations inside
    # recipe-body comment lines too, and one here is a hard parse error for the whole file.
    test -f client-wasm/pkg/client_wasm.js
    cd client && npm ci && npm i --no-save -D @vitest/coverage-v8@$(node -p 'require("vitest/package.json").version') && npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.thresholds.lines=96

build:
    spacetime build --module-path server-module

publish:
    spacetime publish --module-path server-module {{db}}

# Regenerate the committed CHANGELOG.md (ADR-0165 / ADR-0196).
#
# WHY THE VERSION ASSERTION. The nightly `changelog-freshness` job installs
# `git-cliff@{{GIT_CLIFF_VERSION}}` on the READER side, while a local regeneration used
# whatever git-cliff happened to be on PATH. A mismatch re-renders every entry, so the
# checker reports the whole ledger as missing+extra at once and REDS the nightly as
# drift — for a reason that has nothing to do with ledger freshness. Worse, the remedy
# it prints ("run `just changelog`") REPRODUCES the mismatch, which is exactly the
# nag-then-bypass mode ADR-0165 rejected. Failing loud with the install command is the
# only honest outcome.
#
# Asserting on `git cliff` (the binary this recipe then INVOKES), never on some other
# path, is deliberate: asserting one binary and mutating with another is the classic
# bypass. The assertion alone is NOT sufficient, so the generation line adds two more
# clauses (both measured as live bypasses of a version-check-only recipe):
#   - `env -u GIT_CLIFF_*` — git-cliff gives EVERY cli option an environment twin, so a
#     genuine, correctly-pinned binary will happily render an attacker's template with
#     `GIT_CLIFF_CONFIG` set and the version assertion fully satisfied. `--config
#     cliff.toml` then names the SSOT template explicitly rather than relying on
#     discovery.
#   - render to a temp file, `mv` on success — `git cliff -o CHANGELOG.md` TRUNCATES the
#     target BEFORE rendering, so a template error leaves the committed ledger destroyed
#     and exits 1. `set -euo pipefail` does not protect a partially-written output file.
#
# The `#!/usr/bin/env bash` shebang form BYPASSES `windows-shell` (justfile:1) — this
# recipe is bash-only on Windows. That is the same tradeoff `test:` already takes, and
# the reason is the same: the body needs `set -euo pipefail` and a multi-line `if`,
# which just's line-by-line default execution cannot express.
changelog:
    #!/usr/bin/env bash
    set -euo pipefail
    have="$(git cliff --version 2>/dev/null || true)"
    want="git-cliff {{GIT_CLIFF_VERSION}}"
    if [ "$have" != "$want" ]; then
        echo "changelog: git-cliff version mismatch — have '${have:-<not installed>}', want '$want'" >&2
        echo "changelog: install with: cargo install git-cliff --version {{GIT_CLIFF_VERSION}} --locked" >&2
        exit 1
    fi
    tmp="$(mktemp)"
    env -u GIT_CLIFF_CONFIG -u GIT_CLIFF_TEMPLATE -u GIT_CLIFF_TAG_PATTERN -u GIT_CLIFF_OUTPUT -u GIT_CLIFF_WORKDIR git cliff --config cliff.toml -o "$tmp"
    mv "$tmp" CHANGELOG.md

# The local half of the nightly `changelog-freshness` gate: the SAME version assertion,
# then the drift checker. Deliberately NOT in `ci:` — ADR-0196's accepted decision is
# that this check is nightly-and-not-per-PR (the ledger may lag by up to one open
# milestone, so a per-PR gate would red on essentially every feature PR for a condition
# that PR did not cause).
changelog-check:
    #!/usr/bin/env bash
    set -euo pipefail
    have="$(git cliff --version 2>/dev/null || true)"
    want="git-cliff {{GIT_CLIFF_VERSION}}"
    if [ "$have" != "$want" ]; then
        echo "changelog-check: git-cliff version mismatch — have '${have:-<not installed>}', want '$want'" >&2
        echo "changelog-check: install with: cargo install git-cliff --version {{GIT_CLIFF_VERSION}} --locked" >&2
        exit 1
    fi
    node scripts/changelog-freshness.mjs --check

# Client (PixiJS) — needs Linux node on PATH (CI setup-node; local asdf node 24.13.1).
client-setup:
    cd client && npm install --include=dev

client-typecheck:
    cd client && npm run typecheck

# Client unit/property tests (vitest + fast-check) — the headless prediction-layer
# gate (convert + Predictor); node-only, no live server or wasm import.
client-test:
    cd client && npm test

# Regenerate the committed TS bindings from the module (bindings-drift gate checks these).
gen:
    spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings

# Multi-client e2e (real browser vs a running instance + published module).
# Needs the wasm pkg (client imports it) + a running spacetime; global-setup
# republishes --delete-data. Shipped as a required CI gate: the `e2e:` job in
# .github/workflows/ci.yml runs this against a containerized spacetime (M5b, ADR-0009).
e2e: wasm
    cd client && npm run e2e

# Nightly a11y DECAY RATCHET (M23 S11, spec §5.7 "CI vs nightly — DECIDED").
# NOT part of `just ci` and deliberately NOT in the eval's REQUIRED_JUST_STEPS:
# adding a browser and a live server to the hermetic gate is the exact thing
# that keeps `e2e` out of it (ADR-0043). Runs in nightly.yml only; the recipe
# body and the nightly wiring are both guarded by evals/ci-gate-wiring.eval.mjs.
#
# WHAT IT MEASURES, AND WHY IT IS NOT CEREMONY. Every mechanical a11y oracle
# that exists today already runs per PR, so re-running them as-is would be a
# gate that can only fail when `just ci` already failed. This recipe instead
# applies the one lens `just ci` structurally CANNOT — decay — and both decay
# shapes below were MEASURED on this tree, not imagined:
#   1. evals/run.mjs fails only at ZERO eval files, so deleting an a11y eval
#      leaves `just eval` green with one fewer check and nobody the wiser.
#   2. a MISSING vitest spec reports numTotalTests:0 and exits 0, so deleting
#      overlayA11yWiring.test.ts leaves `just client-test` green 84 tests
#      lighter.
# Half 1 pins the three a11y evals BY NAME (a deleted or renamed one makes the
# import THROW — fail-closed by construction, no floor needed). Half 2 floors
# the a11y unit tier's size. Nothing else in the repo asserts either property.
#
# Half 3 (rb-19, ADR-0218) is the axe-core + real-browser tier spec §5.7 names as
# this recipe's payload. m23-s11 could not author it — no axe-core existed and no
# slice in the spec's own §4 table owned client/e2e/a11y.spec.ts — so this recipe
# shipped as the seam, printing a DEFERRED banner, and residual R-m23-s11-X10 filled
# it. It applies the one lens the other two halves and the whole of `just ci` are
# structurally blind to: what the accessibility tree ACTUALLY looks like once
# Chromium has applied CSS, computed visibility and resolved ARIA. Source and JSDOM
# oracles can only prove an attribute was written.
# The two MANUAL criteria A11Y-32/A11Y-33 are NEVER covered here — not by axe
# either, which is not a screen reader — and SHALL NEVER be reported as CI-green;
# see docs/a11y-manual-protocol.md.
#
# `: wasm` is load-bearing: src/main.a11yFocus.test.ts imports main.ts, which
# imports ../../client-wasm/pkg/client_wasm.js. Without a prebuilt pkg its 26
# tests fail to RESOLVE (not to assert), which would silently drop the whole
# M23-S5 focus-return tier out of the ratchet. `just wasm` measures ~11s warm.
#
# floor=169 measured at 2770ec9 (8 files / 169 tests / 0 failed / 0 pending /
# 0 todo). axefloor=3 measured at eca6752 (3 axe tests / 0 unexpected / 0 flaky /
# 0 skipped). rmfloor=2 measured at rb-20 (2 reduced-motion tests / 1 file, via
# `npx playwright test --project=reduced-motion --list`). Raise any of them in the
# same commit that adds a11y tests; LOWER one only in a commit that deliberately
# removes some, and say which in the message.
#
# Half 4 is the reduced-motion BROWSER tier (rb-20, ADR-0219). It covers the
# STYLESHEET arm of A11Y-27 only -- styles.css's `.hp-fill` transition under
# `@media (prefers-reduced-motion: reduce)`, proven to be EVALUATED by Chromium
# rather than merely present in the file. A11Y-27's RENDERER arm is NOT covered
# and is not implemented at all (main.ts passes no `reduceMotion` to
# resolver.resolve); it is ledger gate rb-20 RM-7, DEFERred to backlog. Do not
# relabel half 4 "A11Y-27, gated".
#
# Half 3 needs a BROWSER and a LIVE SpacetimeDB: client/e2e/a11y.spec.ts runs under
# the default client/playwright.config.ts, whose globalSetup republishes the module.
# The nightly a11y-e2e job provisions both, and so does ci.yml's `e2e` job — because
# that config's testDir is ./e2e, `just e2e` COLLECTS a11y.spec.ts too, so the axe
# scan is ALSO a per-PR merge gate. That was deliberate: it costs ~3s in a job that
# already runs a browser and a server, and excluding it would mean putting a
# `--grep-invert` — a neuter-shaped construct — into the one recipe that has none.
# What stays true, and is what spec 5.7 actually constrains, is that the HERMETIC
# gate is untouched: `a11y-e2e` is not a `ci:` dependency and is not in the eval's
# REQUIRED_JUST_STEPS (ADR-0043, ADR-0218).
# Response policy + owner: docs/nightly-red-response-policy.md.
a11y-e2e floor="169" axefloor="3" rmfloor="2": wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # Fail loud on a malformed floor BEFORE the run. BOTH floors are guarded, and
    # the axe one is not decoration: it reaches `Number(process.argv[1])`, and
    # `Number('')` is 0 while `Number('abc')` is NaN — `s.expected < NaN` is FALSE,
    # so an empty or non-numeric axefloor makes half 3 print A11Y-AXE OK on a
    # ZERO-test report. That is the same vacuous-green class ADR-0183 D7 records
    # for `[ "" -gt N ]` in a set -e-exempt if-condition, arriving by a different
    # route; the two `node -e` blocks below compare numerically rather than with
    # `[ -gt ]`, so this `case` is the whole guard.
    case "{{floor}}" in
        ''|*[!0-9]*) echo "a11y-e2e: floor '{{floor}}' is not a non-negative integer" >&2; exit 64;;
    esac
    case "{{axefloor}}" in
        ''|*[!0-9]*) echo "a11y-e2e: axefloor '{{axefloor}}' is not a non-negative integer" >&2; exit 64;;
    esac
    case "{{rmfloor}}" in
        ''|*[!0-9]*) echo "a11y-e2e: rmfloor '{{rmfloor}}' is not a non-negative integer" >&2; exit 64;;
    esac
    # --- Half 1: the a11y eval roster, pinned BY NAME. A deleted or renamed
    # eval makes import() throw, which set -e turns into a non-zero exit.
    # `node evals/<x>.eval.mjs` alone exits 0 VACUOUSLY (these three carry no
    # main guard, by design: a main guard truncates run.mjs mid-loop at exit 0),
    # so the default export must be imported and called.
    a11y_eval_check() {
        node -e "import(process.argv[1]).then(m => m.default()).then(r => { if (!r.pass) { console.error('a11y eval FAIL: ' + r.name + ' — ' + r.detail); process.exit(1) } const m = /teeth=(\\d+)\\/(\\d+)/.exec(String(r.detail)); if (m === null) { console.error('a11y eval reports NO teeth tally: ' + r.name + ' — an eval that runs no inline fixtures proves nothing, and a body gutted to a bare pass:true looks identical to a real one'); process.exit(1) } if (m[1] !== m[2] || Number(m[1]) < 1) { console.error('a11y eval teeth uneven or empty: ' + r.name + ' — ' + m[0]); process.exit(1) } console.log('  teeth ' + m[0]) })" -- "$1"
        echo "a11y eval OK: $1"
    }
    a11y_eval_check ./evals/overlay-a11y-manifest.eval.mjs
    a11y_eval_check ./evals/a11y-static-shell.eval.mjs
    a11y_eval_check ./evals/reduced-motion-purity.eval.mjs
    # --- Half 2: floor the a11y unit tier. Delete the stale report first: a
    # leftover report from a previous run would be read as this run's result if
    # vitest died before writing (measured shape).
    rm -f /tmp/a11y-e2e-vitest.json
    cd client && npx vitest run --reporter=json --outputFile=/tmp/a11y-e2e-vitest.json \
        src/ui/overlayA11yWiring.test.ts \
        src/ui/overlayA11y.test.ts \
        src/ui/focusTrap.test.ts \
        src/ui/liveRegion.test.ts \
        src/ui/announcements.test.ts \
        src/ui/a11yCopy.test.ts \
        src/main.a11yFocus.test.ts \
        src/render/motionPreference.test.ts
    cd ..
    node -e "const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-vitest.json', 'utf8')) } catch (e) { console.error('a11y-e2e: vitest wrote no readable JSON report — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const files = j.testResults.length; const total = j.numTotalTests; if (files !== 8) { console.error('a11y-e2e: ' + files + ' spec file(s) reported, expected 8 — an a11y spec file was deleted or renamed'); process.exit(1) } if (j.numFailedTests !== 0 || j.numPendingTests !== 0 || j.numTodoTests !== 0) { console.error('a11y-e2e: failed=' + j.numFailedTests + ' pending=' + j.numPendingTests + ' todo=' + j.numTodoTests + ' — a skipped a11y test is a silently ungated one'); process.exit(1) } if (total < floor) { console.error('a11y-e2e: a11y unit tier reported ' + total + ' test(s) across ' + files + ' file(s) — floor is ' + floor); process.exit(1) } console.log('A11Y-NIGHTLY OK evals=3/3 files=' + files + ' tests=' + total + ' floor=' + floor + ' f=0 pend=0 todo=0')" -- "{{floor}}"
    # --- Half 3: the axe-core + real-browser tier. Same stale-report discipline as
    # half 2 — a leftover report from a previous run would be read as this run's
    # result if playwright died before writing. The floor is asserted from the
    # machine-readable report and never from console text: a MISSING spec file makes
    # playwright report zero tests and exit 0, the same silent-zero shape vitest has.
    rm -f /tmp/a11y-e2e-axe.json
    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-axe.json \
        npx playwright test e2e/a11y.spec.ts --reporter=json
    cd ..
    node -e "const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-axe.json', 'utf8')) } catch (e) { console.error('a11y-e2e: playwright wrote no readable JSON report — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const s = j.stats; if (s === undefined) { console.error('a11y-e2e: playwright report carries no stats block'); process.exit(1) } if (s.unexpected !== 0 || s.flaky !== 0 || s.skipped !== 0) { console.error('a11y-e2e: axe tier unexpected=' + s.unexpected + ' flaky=' + s.flaky + ' skipped=' + s.skipped + ' — a skipped or flaky a11y test is a silently ungated one'); process.exit(1) } if (s.expected < floor) { console.error('a11y-e2e: axe tier reported ' + s.expected + ' passing test(s) — floor is ' + floor + '; a MISSING spec file reports zero and exits 0'); process.exit(1) } console.log('A11Y-AXE OK tests=' + s.expected + ' floor=' + floor + ' unexpected=0 flaky=0 skipped=0')" -- "{{axefloor}}"
    # --- Half 4: the reduced-motion browser tier (rb-20, ADR-0219). Same stale-
    # report discipline as halves 2 and 3, and its OWN report path: reusing half
    # 3's would clobber the axe evidence and a red in whichever tier ran second
    # would be read as belonging to whichever ran first. Both paths are listed in
    # nightly.yml's failure-evidence artifact.
    #
    # `--project=reduced-motion` is LOAD-BEARING. client/playwright.config.ts now
    # declares two projects, and an invocation naming none runs BOTH -- i.e. all
    # 21 spec files, with a browser and a full world, instead of this project's
    # two tests.
    #
    # ACCURACY NOTE -- this deliberately does NOT inherit half 3's rationale
    # above, which is stale. MEASURED on the pinned @playwright/test 1.61.1: a
    # MISSING spec file, an EMPTY spec file and a --project naming no project ALL
    # exit 1 with "No tests found", so `set -euo pipefail` kills this recipe
    # before any floor check could run. The shape that really does report
    # expected=0 and exit 0 is a wholly `test.describe.skip`-ed spec file -- and
    # the `s.skipped !== 0` clause below is what catches it. The floor is still
    # read from the machine-readable report and never from console text.
    rm -f /tmp/a11y-e2e-rm.json
    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-rm.json \
        npx playwright test --project=reduced-motion --reporter=json
    cd ..
    node -e "const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-rm.json', 'utf8')) } catch (e) { console.error('a11y-e2e: playwright wrote no readable JSON report for the reduced-motion tier — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const s = j.stats; if (s === undefined) { console.error('a11y-e2e: reduced-motion report carries no stats block'); process.exit(1) } if (s.unexpected !== 0 || s.flaky !== 0 || s.skipped !== 0) { console.error('a11y-e2e: reduced-motion tier unexpected=' + s.unexpected + ' flaky=' + s.flaky + ' skipped=' + s.skipped + ' — a wholly describe.skip-ed spec file reports expected=0 and exits 0, and a skipped or flaky a11y test is a silently ungated one'); process.exit(1) } if (s.expected < floor) { console.error('a11y-e2e: reduced-motion tier reported ' + s.expected + ' passing test(s) — floor is ' + floor); process.exit(1) } console.log('A11Y-RM OK tests=' + s.expected + ' floor=' + floor + ' unexpected=0 flaky=0 skipped=0')" -- "{{rmfloor}}"
    echo "DEFERRED: A11Y-32 / A11Y-33 are MANUAL and are NEVER CI-green — docs/a11y-manual-protocol.md"

# Fast inner loop: clippy + nextest + doctests scoped to a single crate.
# Use during red-green iteration instead of the full `just ci`.
ci-fast crate:
    cargo clippy -p {{crate}} --all-targets --all-features -- -D warnings
    cargo nextest run -p {{crate}}
    cargo test --doc -p {{crate}}

# Print sccache env vars to stdout. Source with: eval "$(just cache-on)"
# Opt-in for local dev; CI uses Swatinem/rust-cache instead.
# Contributors without sccache installed are unaffected (not auto-enabled).
cache-on:
    @echo 'export RUSTC_WRAPPER=sccache'
    @echo 'export SCCACHE_DIR=${SCCACHE_DIR:-$HOME/.cache/sccache}'
    @echo 'export SCCACHE_CACHE_SIZE=${SCCACHE_CACHE_SIZE:-2G}'
    @echo 'export CARGO_INCREMENTAL=0'

# Nightly republish smoke test (ADR-0079 / spec §12.5b-6). Requires a running
# SpacetimeDB instance and the spacetime CLI on PATH. Temporarily patches
# CONTENT_VERSION to force a re-seed via sync_content; restores lib.rs on exit.
# Uses an isolated DB name (MR_SMOKE_DB; default: monster-realm-smoke) so it
# never collides with the regular dev/e2e database.
# macOS: uses GNU sed (sed -i without suffix); install via: brew install gnu-sed.
smoke-republish:
    bash scripts/smoke-republish.sh "${STDB_SERVER:-http://127.0.0.1:3000}" "${MR_SMOKE_DB:-monster-realm-smoke}"

# Regenerate the committed docs/knowledge/ OKF bundle from server-module source.
# Run after schema/reducer changes. Bundle is diff-reviewable; drift fails CI via
# the knowledge-bundle-conformance eval (M8.95b).
knowledge:
    node scripts/okf-export.mjs docs/knowledge

# Drift-check the committed bundle against a fresh generation; exit 1 if stale.
knowledge-check:
    node scripts/okf-export.mjs docs/knowledge --check

# Regenerate docs/adr/DIGEST.md from the ADR corpus (ADR-0104).
# Run after any ADR change and before committing.
adr-digest:
    node scripts/adr-digest.mjs

# Drift-check the committed DIGEST.md; exit 1 if stale or header violations found.
# Invoked by `just ci` via the adr-digest eval.
adr-digest-check:
    node scripts/adr-digest.mjs --check

# ---------------------------------------------------------------------------
# Local playtest ops (pt-a2, ADR-0129). Needs a live SpacetimeDB instance + a
# built client; NOT part of `just ci` (same class as smoke-republish/e2e — the
# eval gates the pure checkers + wiring, the live behavior is gated here).
# Env: STDB_SERVER (default http://127.0.0.1:3000), MR_PLAYTEST_DB (default
# monster-realm-playtest). The honest publish is the DEFAULT publish — no cargo
# features, no custom binary path.
# ---------------------------------------------------------------------------

# Fail fast, and legibly, when no SpacetimeDB answers at $STDB_SERVER (ux3-1, ADR-0153).
# `spacetime server ping` is the CLI's OWN liveness check and resolves $STDB_SERVER
# through the SAME path `publish -s` does, so a `spacetime server` NICKNAME (e.g. `local`)
# preflights correctly — a raw `curl "$STDB_SERVER/v1/ping"` would fail DNS on one and
# confidently misdiagnose a healthy server, which is worse than the opaque error this
# replaces. `timeout` is load-bearing: ping has no timeout of its own and hangs
# indefinitely against a black-holed host.
playtest-preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    # Self-default so a standalone `just playtest-preflight` does not die under `set -u`;
    # identical form to the callers', so parent and child can never resolve a different host.
    STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    # A missing CLI is a DIFFERENT fault than a stopped server — telling someone to run
    # 'spacetime start' when the binary is absent is misattribution, so it gets its own message.
    command -v spacetime >/dev/null 2>&1 || { echo "playtest-preflight: the 'spacetime' CLI is not on PATH — install it before running playtest-*." >&2; exit 1; }
    # Symmetric with the CLI check: without GNU timeout the probe below returns 127 and a
    # HEALTHY server would be reported as down — the misdiagnosis this recipe exists to avoid.
    command -v timeout >/dev/null 2>&1 || { echo "playtest-preflight: GNU 'timeout' is not on PATH (macOS: brew install coreutils) — the probe cannot be bounded." >&2; exit 1; }
    # Match the OUTPUT, not just the exit code: `server ping` exits 0 for ANY completed HTTP
    # round-trip, so a 404 (a trailing slash or path suffix on $STDB_SERVER) and a 500 from
    # some unrelated service on that port both "succeed". Only the literal "Server is online"
    # line means a SpacetimeDB actually answered. Exit-code-only would let playtest-up pay a
    # full wasm build before dying at publish — precisely the cost ux3 exists to remove.
    if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || ! printf '%s' "$PING_OUT" | grep -q 'Server is online'; then
        echo "playtest-preflight: no SpacetimeDB responding at $STDB_SERVER — $(printf '%s' "$PING_OUT" | tail -n 1). Start one first: 'spacetime start' — or set STDB_SERVER to the host you meant." >&2
        exit 1
    fi

# Publish the honest release module to the isolated playtest DB, seed content,
# prove no dev reducers/hooks, build the client, and serve the production build.
playtest-up:
    #!/usr/bin/env bash
    set -euo pipefail
    # Export so a nested `just playtest-verify-*` (a child process) inherits the
    # SAME resolved DB/server rather than re-deriving its own default.
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    # Reject-not-clamp: never publish to the dev-default DB. Case-insensitive
    # fold so MONSTER-REALM cannot bypass the guard.
    if [ "${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then
        echo "playtest-up: refusing to publish to the dev-default DB 'monster-realm' — set MR_PLAYTEST_DB to an isolated name" >&2
        exit 1
    fi
    # Cheapest and most specific check first: the DB-name guard above needs no network,
    # so a config typo still reports itself even when the server is down. Then preflight,
    # BEFORE the build (ux3-1, ADR-0153) — a dead server costs ~15 ms instead of a full
    # wasm build followed by an opaque tcp connect error. A compile error still surfaces
    # before the publish, and with the server down this recipe cannot succeed either way.
    just playtest-preflight
    spacetime build --module-path server-module
    # Honest DEFAULT publish (no delete-data so existing session data survives
    # per ADR-0006). No custom features, no custom binary path.
    spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"
    # Seed content as owner (ADR-0006); output-checked (owner path can surface
    # unauthorized). `if ! VAR=$(cmd)` keeps set -e; no wrapping JSON array.
    if ! SYNC_OUT=$(spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content 2>&1); then
        echo "playtest-up: sync_content call exited non-zero: $SYNC_OUT" >&2
        exit 1
    fi
    if echo "$SYNC_OUT" | grep -qi "rejected\|unauthorized"; then
        echo "playtest-up: sync_content was rejected (check owner identity): $SYNC_OUT" >&2
        exit 1
    fi
    just playtest-verify-release
    # Bake the playtest DB into the client at BUILD time: main.ts reads VITE_STDB_DB
    # via Vite's define, and the production build's connectionConfig guard REFUSES an
    # unset/dev-default DB (ADR-0128). Without threading MR_PLAYTEST_DB -> VITE_STDB_DB
    # here, the served bundle throws "production build refuses the dev-default database"
    # at runtime. (URI keeps its ws://127.0.0.1:3000 default — local-only topology.)
    ( cd client && VITE_STDB_DB="$MR_PLAYTEST_DB" npm run build )
    just playtest-verify-build
    # Background the production preview under a TMPDIR PID file so playtest-down
    # can stop it. `exec` makes the subshell BECOME vite, so $! is vite's real
    # PID (clean teardown, no orphaned child); `disown` detaches it from job
    # control so the recipe shell exiting cannot SIGHUP it. The vite binary path
    # is relative to the client dir (the subshell already cd'd into it — an
    # absolute `client/node_modules/...` here would wrongly become client/client).
    ( cd client && exec ./node_modules/.bin/vite preview ) &
    PREVIEW_PID=$!
    disown "$PREVIEW_PID" 2>/dev/null || true
    echo "$PREVIEW_PID" > "${TMPDIR:-/tmp}/mr-playtest-preview.pid"
    echo "playtest-up: serving the production build on the vite preview URL printed above; DB=$MR_PLAYTEST_DB server=$STDB_SERVER"

# Stop the served client preview. The module + data PERSIST (wipe with
# playtest-wipe).
playtest-down:
    #!/usr/bin/env bash
    set -euo pipefail
    kill "$(cat "${TMPDIR:-/tmp}/mr-playtest-preview.pid")" 2>/dev/null || true
    rm -f "${TMPDIR:-/tmp}/mr-playtest-preview.pid"
    echo "playtest-down: preview stopped. The published module + data persist (use 'just playtest-wipe' for a fresh state)."

# Prove the PUBLISHED playtest module carries no dev reducers (describe --json).
playtest-verify-release:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/verify-release-reducers.mjs

# Prove the built client/dist carries no DEV debug hooks.
playtest-verify-build:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/verify-build-hooks.mjs

# Wipe + republish the playtest DB from scratch (fresh state) and re-seed. No
# separate build step — publish rebuilds. Re-proves dev-reducers-absent after
# the republish (the module is rebuilt).
playtest-wipe:
    #!/usr/bin/env bash
    set -euo pipefail
    # Export so a nested `just playtest-verify-*` (a child process) inherits the
    # SAME resolved DB/server rather than re-deriving its own default.
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    if [ "${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then
        echo "playtest-wipe: refusing to wipe the dev-default DB 'monster-realm' — set MR_PLAYTEST_DB to an isolated name" >&2
        exit 1
    fi
    # Same ordering as playtest-up: local guard, then reachability, then the network call
    # (ux3-1, ADR-0153). `publish` is this recipe's first live step — there is no separate
    # build — so without this the failure mode is the bare tcp connect error.
    just playtest-preflight
    spacetime publish -s "$STDB_SERVER" --module-path server-module --delete-data -y "$MR_PLAYTEST_DB"
    # After --delete-data, init re-runs and the publishing identity is
    # re-registered as owner; sync_content must come from that owner.
    if ! SYNC_OUT=$(spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content 2>&1); then
        echo "playtest-wipe: sync_content call exited non-zero: $SYNC_OUT" >&2
        exit 1
    fi
    if echo "$SYNC_OUT" | grep -qi "rejected\|unauthorized"; then
        echo "playtest-wipe: sync_content was rejected (check owner identity): $SYNC_OUT" >&2
        exit 1
    fi
    just playtest-verify-release

# Aggregate the playtest_event table into the GDD §4 H1/H2 proxy report (pt-b2,
# ADR-0131). NOT in `just ci` (live-DB dependent). Env: STDB_SERVER, MR_PLAYTEST_DB.
playtest-report:
    #!/usr/bin/env bash
    set -euo pipefail
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    node scripts/playtest-report.mjs

# Tier-2 observability validation (lp-05, ADR-0201): runs each upstream config
# validator inside the digest-pinned image the stack deploys. `--require-docker`
# is what makes this a GATE — without it a missing docker reports `skipped` and
# exits 0, which in CI is a pass that checked nothing (EARS-2).
observability-validate:
    node ops/observability/validate.mjs --require-docker

ci: lint typecheck test eval security wasm client-typecheck client-test observability-validate
