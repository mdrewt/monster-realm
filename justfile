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
    # The dev-reducer tests are compiled out of the default build, so they only run with the feature.
    cargo nextest run -p monster-realm-module --features dev_reducers
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

# Playwright multi-client e2e (both projects) against a running spacetime. `args` go to
# Playwright: CI's e2e job runs one `--shard=i/N` per runner.
e2e *args: wasm
    cd client && npm run e2e -- {{args}}

# The whole e2e suite as MR_E2E_SHARDS concurrent Playwright shard processes against the ONE
# running SpacetimeDB (STDB_SERVER / VITE_STDB_URI as for `just e2e`). Each shard owns a database
# ({{db}}-shard-<i>) and a vite port (MR_E2E_PORT, default 5290, plus <i>), so the specs' exact
# live-population assertions hold per shard. The dev_reducers module is built here and always
# passed as MR_DEV_MODULE_WASM: a publish without that feature passes globalSetup and then fails
# every spec that calls a dev reducer. Exits non-zero naming each failed shard and its log.
e2e-shards: wasm
    #!/usr/bin/env bash
    set -euo pipefail
    n="${MR_E2E_SHARDS:-4}"
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "e2e-shards: MR_E2E_SHARDS '$n' is not a positive integer" >&2; exit 64; }
    base_port="${MR_E2E_PORT:-5290}"
    cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features dev_reducers
    MR_DEV_MODULE_WASM="$(realpath "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/monster_realm_module.wasm")"
    export MR_DEV_MODULE_WASM
    cd client
    out=test-results/shards
    mkdir -p "$out"
    pids=()
    trap 'kill "${pids[@]}" 2>/dev/null || true' INT TERM
    for i in $(seq 1 "$n"); do
        VITE_STDB_DB="{{db}}-shard-$i" MR_E2E_PORT=$((base_port + i)) \
            npm run --silent e2e -- --shard="$i/$n" --output="$out/shard-$i" > "$out/shard-$i.log" 2>&1 &
        pids+=("$!")
    done
    failed=0
    for i in $(seq 1 "$n"); do
        status=ok
        wait "${pids[$((i - 1))]}" || { status=FAILED; failed=$((failed + 1)); }
        counts="$(grep -E '^ +[0-9]+ (passed|failed|flaky|skipped|did not run)' "$out/shard-$i.log" | tr -s ' \n' ' ' || true)"
        echo "e2e-shards: shard $i/$n $status —${counts:- no summary }— client/$out/shard-$i.log"
    done
    if [ "$failed" -gt 0 ]; then
        echo "e2e-shards: $failed of $n shards failed" >&2
        exit 1
    fi

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
#
# `shard` ("k/n", 0-based; empty = the whole crate) is how the nightly fits under GitHub's 6 h job cap:
# the crate outgrew one serial job (2052 mutants), so CI runs n shards in a matrix. Each shard is
# its own zero-tolerance verdict, so the AND over the shards equals the unsharded gate.
mutate-core shard="":
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{shard}}" =~ ^([0-9]+/[0-9]+)?$ ]] || { echo "mutate-core: shard '{{shard}}' is not k/n" >&2; exit 64; }
    shard_args=(); [ -n "{{shard}}" ] && shard_args=(--shard "{{shard}}")
    # Backstop for a runaway-allocation mutant (one once pushed ~550 MB/s until the whole 16 GB
    # runner died, see .cargo/mutants.toml #5): cap each process's address space so the allocation
    # aborts the test (= caught) instead of taking the machine down. The unmutated build + full
    # test run fits in 8 GB. `|| true`: platforms without `ulimit -v` simply run uncapped.
    ulimit -v 8000000 2>/dev/null || true
    status=0
    cargo mutants -p game-core ${shard_args[@]+"${shard_args[@]}"} || status=$?
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

# Local pre-push check: mutate only the code COMMITTED since `base` (game-core + server-module);
# uncommitted edits are not seen.
# Empty diff = nothing to mutate. Same exit triage as mutate-core (0 ok, 2 missed, 3 timeouts).
mutate-diff base="origin/master":
    #!/usr/bin/env bash
    set -euo pipefail
    diff_file=$(mktemp)
    trap 'rm -f "$diff_file"' EXIT
    git diff "{{base}}...HEAD" -- game-core server-module > "$diff_file"
    [ -s "$diff_file" ] || { echo "mutate-diff: no game-core/server-module changes vs {{base}}"; exit 0; }
    ulimit -v 8000000 2>/dev/null || true
    status=0
    cargo mutants -p game-core -p monster-realm-module --test-tool nextest --in-diff "$diff_file" || status=$?
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    # Judge by missed.txt, not the exit code alone: exit 3 (timeouts) can accompany missed mutants.
    if [ -s mutants.out/missed.txt ]; then
        cat mutants.out/missed.txt >&2
        echo "mutate-diff: $(grep -c '' mutants.out/missed.txt) missed mutant(s) in the diff" >&2
        exit 1
    fi

# Server-module mutation gate, zero tolerance like game-core: a surviving mutant is either killed by
# a test or, if provably equivalent / log-only, excluded in .cargo/mutants.toml with the proof.
# There is no survivor budget to creep. The crate is `monster-realm-module`.
#
# Unsharded (`shard` empty) it runs the whole crate. The nightly runs a matrix of `k/n` shards to
# fit the 6 h job cap (~1500 mutants); every shard is its own zero-tolerance verdict, like mutate-core.
mutate-server shard="":
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{shard}}" =~ ^([0-9]+/[0-9]+)?$ ]] || { echo "mutate-server: shard '{{shard}}' is not k/n" >&2; exit 64; }
    shard_args=(); [ -n "{{shard}}" ] && shard_args=(--shard "{{shard}}")
    # Same runaway-allocation backstop as mutate-core (protects the 16 GB runner).
    ulimit -v 8000000 2>/dev/null || true
    # dtolnay/rust-toolchain exports CARGO_INCREMENTAL=0 into GITHUB_ENV and cargo-mutants rebuilds
    # once per mutant. Incremental cuts the server build per mutant from ~20 s to ~5 s (measured,
    # same verdicts); game-core already rebuilds in ~0.5 s per mutant, so it is left alone.
    export CARGO_INCREMENTAL=1
    echo "CARGO_INCREMENTAL=$CARGO_INCREMENTAL"
    status=0
    cargo mutants -p monster-realm-module --test-tool nextest ${shard_args[@]+"${shard_args[@]}"} || status=$?
    # 0 = clean; 2 = missed mutants; 3 = timeouts (a hang is a detection, so they count as
    # caught; they may accompany missed). Same set as mutate-core. Anything else is not a verdict.
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    # Not redundant with set -e: without the file, missed="" and the `-gt` test below errors
    # inside an if-condition, which set -e exempts — a vacuous green.
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutate-server: mutants.out/missed.txt absent — cannot verify zero-missed" >&2
        exit 1
    fi
    missed=$(grep -c '' mutants.out/missed.txt || true)
    echo "mutate-server: missed=$missed (zero-tolerance${shard_args[*]:+, shard {{shard}}})"
    if [ "$missed" -gt 0 ]; then
        cat mutants.out/missed.txt >&2
        echo "server-module mutation gate: $missed surviving mutant(s) — zero-tolerance" >&2
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
# Depends on `wasm` so a fresh clone's `npm run build` finds the prediction pkg.
playtest-up: wasm
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
