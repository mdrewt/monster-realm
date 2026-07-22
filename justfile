set windows-shell := ["cmd.exe", "/c"]

# Integration-runtime isolation: the published db name is env-driven (default
# unchanged), aligned with the client's VITE_STDB_DB, so two concurrent local
# integration/e2e runs can set distinct VITE_STDB_DB (+ MR_E2E_PORT, see
# client/playwright.config.ts) and not collide on one db/port (one shared
# SpacetimeDB instance hosts both; distinct db names isolate their data).
db := env_var_or_default("VITE_STDB_DB", "monster-realm")
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

test:
    cargo nextest run --workspace
    cargo test --doc --workspace

eval:
    node evals/run.mjs

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
# units, so surviving mutants are counted against a cap (baseline 299 missed of
# 513 mutants @ m17.5a, 2026-07-17, ADR-0118 §4 re-baseline; prior baselines 308
# @ m17a 2026-07-17, 309 @ 908c99b 2026-07-15 per ADR-0118, 180 @ e875af0
# 2026-07-04) instead of failing on any survivor (game-core's mutate-core
# keeps zero-tolerance). `--test-tool nextest` is pinned for determinism with the
# recorded baseline (zero doctests in the crate, so catch results are identical).
# Cap bumps must update ADR-0050. Runs in nightly.yml only (mutation-server job);
# the recipe body is integrity-guarded by evals/nightly-smoke-wiring.eval.mjs.
mutate-server cap="299":
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
    # missed.txt exists whenever cargo-mutants ran (exit 0 or 2); a missing file
    # aborts via set -e — the correct fail-loud path. grep -c '' counts lines
    # regardless of a trailing newline (wc -l undercounts a newline-less last
    # line); || true keeps the empty-file (0 survivors) case alive under set -e.
    missed=$(grep -c '' mutants.out/missed.txt || true)
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
# Under vitest 4 (AST-aware v8) re-measured at 97.56% lines — still >96 (amendment 2026-07-22).
coverage:
    cd client && npm ci && npm i --no-save -D @vitest/coverage-v8@$(node -p 'require("vitest/package.json").version') && npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.thresholds.lines=96

build:
    spacetime build --module-path server-module

publish:
    spacetime publish --module-path server-module {{db}}

changelog:
    git cliff -o CHANGELOG.md

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
# republishes --delete-data. CI-as-required-gate is M5b (containerized spacetime).
e2e: wasm
    cd client && npm run e2e

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
    # Explicit build first so compile errors surface before network contact.
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

ci: lint typecheck test eval security wasm client-typecheck client-test
