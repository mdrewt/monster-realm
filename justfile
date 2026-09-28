set windows-shell := ["cmd.exe", "/c"]

# Published db name; env-driven (matches the client's VITE_STDB_DB) so concurrent local
# integration/e2e runs can use distinct databases on one SpacetimeDB instance.
db := env_var_or_default("VITE_STDB_DB", "monster-realm")

setup:
    cargo fetch
    cd client && npm install --include=dev

# The merge gate. ci.yml runs these same recipes as individual steps.
ci: lint typecheck test eval security wasm client-typecheck client-test client-verify-build observability-validate

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    client/node_modules/.bin/biome check .

typecheck:
    cargo check --workspace --all-targets

# Rust tests, then two fail-closed node:test doors (ops observability suites, scripts/ tooling).
# `node --test` exits 0 on a zero-test file, an all-skip file, or a failure followed by
# process.exit(0), so each door also checks the file count, parses the summary (unparsed = fatal),
# requires fail=0 and pass >= floor. Re-derive a floor after adding or removing a test.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo nextest run --workspace
    cargo test --doc --workspace
    door() {
        local label=$1 want=$2 floor=$3 out pass fail
        shift 3
        if [ "$#" -ne "$want" ]; then
            echo "$label: expected $want test files, found $#: $*" >&2
            exit 1
        fi
        out="$(mktemp)"
        node --test "$@" 2>&1 | tee "$out"
        pass="$(grep -Eo '^(ℹ|#) pass [0-9]+' "$out" | grep -Eo '[0-9]+$' | tail -1)"
        fail="$(grep -Eo '^(ℹ|#) fail [0-9]+' "$out" | grep -Eo '[0-9]+$' | tail -1)"
        if [ -z "$pass" ] || [ -z "$fail" ]; then
            echo "$label: could not parse the node --test summary" >&2
            exit 1
        fi
        if [ "$fail" -ne 0 ] || [ "$pass" -lt "$floor" ]; then
            echo "$label: pass=$pass fail=$fail (floor $floor)" >&2
            exit 1
        fi
    }
    shopt -s nullglob
    door "ops node suites" 7 141 ops/observability/relay/*.test.mjs ops/observability/checks/stack-config-checks.test.mjs
    door "scripts node suites" 3 18 scripts/*.test.mjs

eval:
    node evals/run.mjs

security:
    node scripts/check-secrets.mjs .

# Client-prediction wasm pkg (--target bundler); gitignored, imported by the client and evals.
wasm:
    wasm-pack build client-wasm --target bundler

client-typecheck:
    cd client && npm run typecheck

client-test:
    cd client && npm test

# Build the production client with the playtest DB baked in and prove client/dist ships no
# DEV debug hooks (__game/__mrTrade/__mrPvp).
client-verify-build: wasm
    cd client && VITE_STDB_DB=monster-realm-playtest npm run build
    MR_PLAYTEST_DB=monster-realm-playtest node scripts/verify-build-hooks.mjs

# Upstream config validators in the digest-pinned images; --require-docker makes a missing
# docker a failure instead of a skip.
observability-validate:
    node ops/observability/validate.mjs --require-docker

# Regenerate the committed TS bindings (the bindings-drift eval diffs against these).
gen:
    spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings

build:
    spacetime build --module-path server-module

publish:
    spacetime publish --module-path server-module {{db}}

# Playwright multi-client e2e (both projects) against a running spacetime; CI's e2e job.
e2e: wasm
    cd client && npm run e2e

# Inner loop for one crate.
ci-fast crate:
    cargo clippy -p {{crate}} --all-targets --all-features -- -D warnings
    cargo nextest run -p {{crate}}
    cargo test --doc -p {{crate}}

# Opt-in local sccache: eval "$(just cache-on)"
cache-on:
    @echo 'export RUSTC_WRAPPER=sccache'
    @echo 'export SCCACHE_DIR=${SCCACHE_DIR:-$HOME/.cache/sccache}'
    @echo 'export SCCACHE_CACHE_SIZE=${SCCACHE_CACHE_SIZE:-2G}'
    @echo 'export CARGO_INCREMENTAL=0'

# ---- nightly gates (.github/workflows/nightly.yml) ----

# criterion bench of the game-core hot paths; fails on a committed-ceiling breach
# (game-core/benches/budgets.rs). Clean estimates so a restored cache can't feed stale data;
# CRITERION_HOME is absolute because cargo runs the bench with cwd = game-core/.
perf-budget:
    #!/usr/bin/env bash
    set -euo pipefail
    export CRITERION_HOME="${CARGO_TARGET_DIR:-$PWD/target}/criterion"
    rm -rf "$CRITERION_HOME"
    cargo bench -p game-core --bench hot_paths

# Client line coverage, report-only (text + json-summary; no threshold). `wasm` first: specs
# that import main.ts need the pkg, and vitest writes no report if any test fails.
coverage: wasm
    cd client && npm ci && npm i --no-save -D @vitest/coverage-v8@$(node -p 'require("vitest/package.json").version') && npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.reporter=json-summary

mutate:
    cargo mutants --workspace

# game-core mutation gate, zero tolerance: any missed mutant fails; timeouts are
# tolerated only when missed=0.
mutate-core:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    cargo mutants -p game-core || status=$?
    # 0 = clean; 2 = missed mutants; 3 = timeouts. Anything else is not a mutation verdict.
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutants.out/missed.txt absent — cannot verify zero-missed" >&2
        exit 1
    fi
    missed=$(wc -l < mutants.out/missed.txt)
    echo "mutate-core: missed=$missed (zero-tolerance)"
    if [ "$missed" -gt 0 ]; then
        echo "game-core mutation gate: $missed surviving mutant(s) — zero-tolerance" >&2
        exit 1
    fi

# Server-module survivor-count ratchet; the crate is `monster-realm-module`.
# Cap rebaselined by the Phase-3 mutants triage (RC-mutate-server): full run at 428314e = 1151
# mutants, 31 missed (29 accepted, one MUT-server-* ledger row per file, + 2 stale-build flakes),
# 1 timeout (evolution.rs check_and_evolve `+=` -> `*=`, counted as caught); cap = 31 + 3 headroom.
mutate-server cap="34":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{cap}}" in
        ''|*[!0-9]*) echo "mutate-server: cap '{{cap}}' is not a non-negative integer" >&2; exit 64;;
    esac
    status=0
    cargo mutants -p monster-realm-module --test-tool nextest || status=$?
    # 0 = clean; 2 = missed mutants; 3 = timeouts (a hang is a detection, so they count as
    # caught; they may accompany missed). Same set as mutate-core. Anything else is not a verdict.
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    # Not redundant with set -e: without the file, missed="" and the `-gt` test below errors
    # inside an if-condition, which set -e exempts — a vacuous green.
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutate-server: mutants.out/missed.txt absent — cannot verify the survivor count" >&2
        exit 1
    fi
    missed=$(grep -c '' mutants.out/missed.txt || true)
    echo "surviving mutants: $missed (cap {{cap}})"
    if [ "$missed" -gt "{{cap}}" ]; then
        echo "survivor count $missed exceeds cap {{cap}} — mutation ratchet violated" >&2
        exit 1
    fi

# Republish over live data with a bumped CONTENT_VERSION and assert data survives + re-seeds.
# Needs a running SpacetimeDB; isolated DB name.
smoke-republish:
    bash scripts/smoke-republish.sh "${STDB_SERVER:-http://127.0.0.1:3000}" "${MR_SMOKE_DB:-monster-realm-smoke}"

# ---- local playtest ops (need a live SpacetimeDB; docs/runbooks/playtest-ops.md) ----
# Env: STDB_SERVER (default http://127.0.0.1:3000), MR_PLAYTEST_DB (default monster-realm-playtest).

# Fail fast when no SpacetimeDB answers. `server ping` resolves nicknames the same way
# `publish -s` does but exits 0 on any HTTP reply, so match its "Server is online" line;
# `timeout` because ping never gives up on a black-holed host.
playtest-preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    command -v spacetime >/dev/null 2>&1 || { echo "playtest-preflight: the 'spacetime' CLI is not on PATH — install it before running playtest-*." >&2; exit 1; }
    command -v timeout >/dev/null 2>&1 || { echo "playtest-preflight: GNU 'timeout' is not on PATH (macOS: brew install coreutils) — the probe cannot be bounded." >&2; exit 1; }
    if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || ! printf '%s' "$PING_OUT" | grep -q 'Server is online'; then
        echo "playtest-preflight: no SpacetimeDB responding at $STDB_SERVER — $(printf '%s' "$PING_OUT" | tail -n 1). Start one first: 'spacetime start' — or set STDB_SERVER to the host you meant." >&2
        exit 1
    fi

# Publish the honest release module (default features) to the isolated playtest DB, seed
# content, prove no dev reducers / DEV hooks, build the client, and serve the production build.
playtest-up:
    #!/usr/bin/env bash
    set -euo pipefail
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    if [ "${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then
        echo "playtest-up: refusing to publish to the dev-default DB 'monster-realm' — set MR_PLAYTEST_DB to an isolated name" >&2
        exit 1
    fi
    just playtest-preflight
    spacetime build --module-path server-module
    spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"
    if ! SYNC_OUT=$(spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content 2>&1); then
        echo "playtest-up: sync_content call exited non-zero: $SYNC_OUT" >&2
        exit 1
    fi
    if echo "$SYNC_OUT" | grep -qi "rejected\|unauthorized"; then
        echo "playtest-up: sync_content was rejected (check owner identity): $SYNC_OUT" >&2
        exit 1
    fi
    just playtest-verify-release
    # The production build refuses an unset/dev-default DB, so bake the playtest DB in.
    ( cd client && VITE_STDB_DB="$MR_PLAYTEST_DB" npm run build )
    just playtest-verify-build
    # `exec` makes $! vite's own PID so playtest-down can stop it; `disown` survives recipe exit.
    ( cd client && exec ./node_modules/.bin/vite preview ) &
    PREVIEW_PID=$!
    disown "$PREVIEW_PID" 2>/dev/null || true
    echo "$PREVIEW_PID" > "${TMPDIR:-/tmp}/mr-playtest-preview.pid"
    echo "playtest-up: serving the production build on the vite preview URL printed above; DB=$MR_PLAYTEST_DB server=$STDB_SERVER"

# Stop the preview; the published module and data persist.
playtest-down:
    #!/usr/bin/env bash
    set -euo pipefail
    kill "$(cat "${TMPDIR:-/tmp}/mr-playtest-preview.pid")" 2>/dev/null || true
    rm -f "${TMPDIR:-/tmp}/mr-playtest-preview.pid"
    echo "playtest-down: preview stopped. The published module + data persist (use 'just playtest-wipe' for a fresh state)."

# Prove the published playtest module exposes no dev reducers (describe --json).
playtest-verify-release:
    node scripts/verify-release-reducers.mjs

# Prove the built client/dist carries no DEV debug hooks.
playtest-verify-build:
    node scripts/verify-build-hooks.mjs

# Delete-data republish + reseed of the playtest DB, then re-verify no dev reducers.
playtest-wipe:
    #!/usr/bin/env bash
    set -euo pipefail
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    if [ "${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then
        echo "playtest-wipe: refusing to wipe the dev-default DB 'monster-realm' — set MR_PLAYTEST_DB to an isolated name" >&2
        exit 1
    fi
    just playtest-preflight
    spacetime publish -s "$STDB_SERVER" --module-path server-module --delete-data -y "$MR_PLAYTEST_DB"
    if ! SYNC_OUT=$(spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content 2>&1); then
        echo "playtest-wipe: sync_content call exited non-zero: $SYNC_OUT" >&2
        exit 1
    fi
    if echo "$SYNC_OUT" | grep -qi "rejected\|unauthorized"; then
        echo "playtest-wipe: sync_content was rejected (check owner identity): $SYNC_OUT" >&2
        exit 1
    fi
    just playtest-verify-release

# Aggregate playtest_event into the GDD §4 H1/H2 proxy report.
playtest-report:
    #!/usr/bin/env bash
    set -euo pipefail
    export STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    export MR_PLAYTEST_DB="${MR_PLAYTEST_DB:-monster-realm-playtest}"
    node scripts/playtest-report.mjs
