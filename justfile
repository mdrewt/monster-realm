set windows-shell := ["cmd.exe", "/c"]

# Published db name; env-driven (VITE_STDB_DB, the name the dev server's shell document also
# gives the client) so concurrent local integration/e2e runs can use distinct databases on one
# SpacetimeDB instance.
db := env_var_or_default("VITE_STDB_DB", "monster-realm")

setup:
    cargo fetch
    cd client && npm install --include=dev

# The merge gate. ci.yml runs these same recipes, one per step, split across parallel jobs.
# `eval` stays ahead of `wasm`: the parity evals leave a nodejs-target pkg that `wasm` replaces.
ci: lint typecheck account-typecheck account-test test eval security wasm client-typecheck client-test client-verify-build observability-validate

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    client/node_modules/.bin/biome check .

typecheck:
    cargo check --workspace --all-targets

# Rust tests, then three fail-closed node:test doors (ops observability suites, scripts/ tooling,
# the justfile's own recipes), then the tester guards' own fixture batteries (.claude/hooks), each
# held to a fixture floor.
# `node --test` exits 0 on a zero-test file, an all-skip file, or a failure followed by
# process.exit(0), so each door also checks the file count, parses the summary (unparsed = fatal),
# requires fail=0 and pass >= floor. Re-derive a floor after adding or removing a test.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo nextest run --workspace
    # The dev-reducer tests are compiled out of the default build, so they only run with the feature.
    # `--workspace` plus a package filter keeps the workspace's unified dependency features, so
    # only the module recompiles; `-p` resolves features for the one package and rebuilds its deps.
    cargo nextest run --workspace --features monster-realm-module/dev_reducers -E 'package(monster-realm-module)'
    # The load build's game-core and module tests (the generated zones, dev_place_in_load_zone) are
    # compiled out of every other build; this line runs both packages whole with that feature.
    cargo nextest run --workspace --features monster-realm-module/load_test_zones -E 'package(game-core) | package(monster-realm-module)'
    # The ownership check refuses nobody on a build that names `open_join`, the default included, so
    # the reducer's own refusals run on a real dev-enforcing build: `dev_issuers` and no default.
    cargo nextest run --workspace --no-default-features --features monster-realm-module/dev_issuers -E 'package(monster-realm-module) & test(/acs6_enforcing/)'
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
    door "scripts node suites" 5 30 scripts/*.test.mjs
    door "justfile node suite" 1 38 justfile.test.mjs
    guard() {
        local hook=$1 ok=$2 floor=$3 out n
        out="$(CLAUDE_PROJECT_DIR="$PWD" node "$hook" --selftest 2>&1)" || { echo "$out" >&2; exit 1; }
        echo "$out"
        n="$(grep -Eo "^$ok [0-9]+ fixtures" <<<"$out" | grep -Eo '[0-9]+' | tail -1)"
        if [ -z "$n" ] || [ "$n" -lt "$floor" ]; then
            echo "$hook: fixtures=${n:-unparsed} (floor $floor)" >&2
            exit 1
        fi
    }
    guard .claude/hooks/guard-tester-bash.mjs TESTER-GUARD-SELFTEST-OK 54
    guard .claude/hooks/guard-tester-write.mjs TESTER-WRITE-GUARD-SELFTEST-OK 23

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

# Build the production client for the playtest DB (VITE_STDB_DB makes the build write
# dist/shell-config.js naming it) and prove client/dist ships no DEV debug hooks
# (__game/__mrTrade/__mrPvp/__mrTactics) and names that DB in shell-config.js only.
client-verify-build: wasm
    cd client && VITE_STDB_DB=monster-realm-playtest npm run build
    MR_PLAYTEST_DB=monster-realm-playtest node scripts/verify-build-hooks.mjs

# ---- account service (account-service/, its own lock file; docs/account-service.md) ----
# `just lint` lints the package with the rest of the tree.

# Install the package's dependencies when they are absent or older than its lock file, without
# running any dependency's install script. A node_modules that is a symlink (a worktree sharing
# another checkout's copy) is left alone.
account-install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd account-service
    if [ -L node_modules ]; then exit 0; fi
    if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
        npm ci --ignore-scripts
    fi

# Run the local-dev profile, issuer http://localhost:4455. By default it listens on
# 127.0.0.1:4455 and keeps its database, and the signing keys it generates on first start, in
# account-service/.data. The recipe fixes the profile; every other MR_ACCOUNT_* setting is the
# caller's environment.
account-dev: account-install
    #!/usr/bin/env bash
    set -euo pipefail
    cd account-service
    MR_ACCOUNT_PROFILE=local-dev exec node src/server.ts

account-typecheck: account-install
    cd account-service && npm run typecheck

account-test: account-install
    cd account-service && npm test

# Upstream config validators in the digest-pinned images; --require-docker makes a missing
# docker a failure instead of a skip.
observability-validate:
    node ops/observability/validate.mjs --require-docker

# Regenerate the committed TS bindings (the bindings-drift eval diffs against these).
gen:
    spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings

build:
    spacetime build --module-path server-module

# ---- modules to ship (docs/local-play.md §3, "The build input") ----

# Print the build profile a module artefact carries: the text of its `mr_build_profile` custom
# section, which the build writes from the constants it computed from its cargo features
# (`profile=`, `enforces_ownership=`, `dev_reducers=`, then a `login_issuer=` line per trusted
# issuer). Fails unless the artefact holds exactly one such section.
module-profile $wasm:
    #!/usr/bin/env node
    const { readFileSync } = require('node:fs');
    const artefact = new WebAssembly.Module(readFileSync(process.env.wasm));
    const sections = WebAssembly.Module.customSections(artefact, 'mr_build_profile');
    if (sections.length !== 1) {
      console.error(
        `module-profile: ${process.env.wasm} holds ${sections.length} mr_build_profile sections; a module build holds exactly one`,
      );
      process.exit(1);
    }
    process.stdout.write(Buffer.from(sections[0]));

# Build a module to ship: `official` (the official server: the production login issuer) or `world`
# (a world a player hosts: no login issuer). Both enforce ownership. It builds the module alone, with
# exactly that feature and no default, into a target directory of its own (the test and e2e builds
# share the other one) and with no compiler flags from the environment or a config file. It then
# reads the profile back from the artefact and refuses one that is not the profile asked for, does
# not enforce ownership, compiles a dev reducer or names one, or trusts anything but one `https:`
# login issuer (`official`) or none (`world`). An accepted artefact is copied to
# <target>/release-module/monster-realm-<profile>.wasm with its SHA-256 beside it (.sha256, the
# `sha256sum` format), and the last line printed is `release-module: <profile> <sha256> <path>`.
# Publish or embed that file by that hash.
release-module profile:
    #!/usr/bin/env bash
    set -euo pipefail
    profile={{quote(profile)}}
    case "$profile" in
        official|world) ;;
        *) echo "release-module: '$profile' is not a module to ship: give official or world" >&2; exit 64 ;;
    esac
    target="${CARGO_TARGET_DIR:-target}"
    build_dir="$target/release-module/$profile"
    out="$target/release-module/monster-realm-$profile.wasm"
    # A refused or failed build leaves no artefact from an earlier run to be taken for this one.
    rm -f "$out" "$out.sha256"
    # An empty CARGO_ENCODED_RUSTFLAGS is cargo's first source of flags, so it also overrides
    # `build.rustflags` and `target.*.rustflags` in a config file.
    env -u RUSTFLAGS -u CARGO_BUILD_RUSTFLAGS -u CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS CARGO_ENCODED_RUSTFLAGS= \
        cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --no-default-features --features "$profile" --target-dir "$build_dir"
    MR_PROFILE="$profile" MR_BUILT="$build_dir/wasm32-unknown-unknown/release/monster_realm_module.wasm" MR_OUT="$out" \
        MR_REDUCER_LIST={{quote(justfile_directory() / "scripts" / "verify-release-reducers.mjs")}} \
        node --input-type=module - <<'EOF'
    import { createHash } from 'node:crypto';
    import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
    import { basename } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { MR_PROFILE: profile, MR_BUILT: built, MR_OUT: out, MR_REDUCER_LIST: reducerList } = process.env;
    const { FORBIDDEN_REDUCERS } = await import(pathToFileURL(reducerList).href);
    const refuse = (why) => {
      console.error(`release-module: refusing ${built}: ${why}`);
      process.exit(1);
    };
    const bytes = readFileSync(built);
    const sections = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'mr_build_profile');
    if (sections.length !== 1) refuse(`it holds ${sections.length} mr_build_profile sections, not one`);
    const lines = Buffer.from(sections[0]).toString('utf8').split('\n');
    if (lines.pop() !== '') refuse('its profile does not end with a newline');
    const issuerKey = 'login_issuer=';
    const issuers = lines.filter((l) => l.startsWith(issuerKey)).map((l) => l.slice(issuerKey.length));
    const facts = lines.filter((l) => !l.startsWith(issuerKey));
    const want = [`profile=${profile}`, 'enforces_ownership=true', 'dev_reducers=false'];
    if (facts.length !== want.length || facts.some((line, i) => line !== want[i])) {
      refuse(`its profile is ${JSON.stringify(facts)}, not ${JSON.stringify(want)}`);
    }
    const trusted =
      profile === 'official' ? issuers.length === 1 && issuers[0].startsWith('https:') : issuers.length === 0;
    if (!trusted) {
      refuse(`a ${profile} module does not trust the login issuers ${JSON.stringify(issuers)}`);
    }
    const named = FORBIDDEN_REDUCERS.filter((name) => bytes.includes(name));
    if (named.length > 0) refuse(`it names the dev reducer(s) ${named.join(', ')}`);
    copyFileSync(built, out);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(`${out}.sha256`, `${sha256}  ${basename(out)}\n`);
    console.log(`release-module: ${profile} ${sha256} ${realpathSync(out)}`);
    EOF

# Publish over whatever {{db}} holds, keeping its data, then re-seed as the owner: `init` runs
# only when a database is created, so `sync_content` is what brings the content and the protocol
# numbers of an existing one in line with the module just published. It refuses every caller but
# the identity that first published the database, and the recipe then exits non-zero.
publish:
    spacetime publish --module-path server-module {{db}}
    spacetime call {{db}} sync_content

# Playwright multi-client e2e (both projects) against a running spacetime. `args` go to
# Playwright: each of CI's e2e-shard jobs runs one `--shard=i/N`.
e2e *args: wasm
    cd client && npm run e2e -- {{args}}

# The whole e2e suite as MR_E2E_SHARDS concurrent Playwright shard processes against the ONE
# running SpacetimeDB (STDB_SERVER / VITE_STDB_URI as for `just e2e`). Each shard owns a database
# ({{db}}-shard-<i>) and a vite port (MR_E2E_PORT, default 5290, plus <i>), so the specs' exact
# live-population assertions hold per shard. The dev_reducers module is built here and always
# passed as MR_DEV_MODULE_WASM: a publish without that feature passes globalSetup and then fails
# every spec that calls a dev reducer. Exits non-zero naming each failed shard and its log; a
# shard that passed no test counts as failed, because `--shard` lets an empty shard exit 0.
# MR_E2E_SHARDS defaults to 8; README "Running the e2e suite locally" has the measurements and
# the budget rule.
e2e-shards: wasm
    #!/usr/bin/env bash
    set -euo pipefail
    n="${MR_E2E_SHARDS:-8}"
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "e2e-shards: MR_E2E_SHARDS '$n' is not a positive integer" >&2; exit 64; }
    base_port="${MR_E2E_PORT:-5290}"
    cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features dev_reducers
    MR_DEV_MODULE_WASM="$(realpath "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/monster_realm_module.wasm")"
    export MR_DEV_MODULE_WASM
    cd client
    out=test-results/shards
    mkdir -p "$out"
    pids=()
    # Stopping the recipe stops every shard's whole tree: npm does not pass the signal on, and
    # Playwright starts vite and chromium in sessions of their own, where a vite left behind
    # keeps its port and fails that shard's next run.
    stop_tree() {
        local child
        for child in $(pgrep -P "$1"); do stop_tree "$child"; done
        kill "$1" 2>/dev/null || true
    }
    trap 'for pid in "${pids[@]}"; do stop_tree "$pid"; done' INT TERM
    for i in $(seq 1 "$n"); do
        VITE_STDB_DB="{{db}}-shard-$i" MR_E2E_PORT=$((base_port + i)) \
            PLAYWRIGHT_JSON_OUTPUT_FILE="$out/shard-$i.json" \
            npm run --silent e2e -- --shard="$i/$n" --output="$out/shard-$i" > "$out/shard-$i.log" 2>&1 &
        pids+=("$!")
    done
    failed=0
    for i in $(seq 1 "$n"); do
        status=ok
        wait "${pids[$((i - 1))]}" || status=FAILED
        counts="$(grep -E '^ +[0-9]+ (passed|failed|flaky|skipped|did not run)' "$out/shard-$i.log" | tr -s ' \n' ' ' || true)"
        [[ "$counts" == *" passed"* ]] || status=FAILED
        [ "$status" = ok ] || failed=$((failed + 1))
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
# the crate outgrew one serial job, so CI runs n shards in a matrix. Each shard is
# its own zero-tolerance verdict, so the AND over the shards equals the unsharded gate.
mutate-core shard="":
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{shard}}" =~ ^([0-9]+/[0-9]+)?$ ]] || { echo "mutate-core: shard '{{shard}}' is not k/n" >&2; exit 64; }
    # round-robin: mutant i runs on shard i % n, so the slow files spread evenly over the shards.
    shard_args=(); [ -n "{{shard}}" ] && shard_args=(--shard "{{shard}}" --sharding round-robin)
    # Backstop for a runaway-allocation mutant (one once pushed ~550 MB/s until the whole 16 GB
    # runner died, see .cargo/mutants.toml #5): cap each process's address space so the allocation
    # aborts the test (= caught) instead of taking the machine down. The unmutated build + full
    # test run fits in 8 GB. `|| true`: platforms without `ulimit -v` simply run uncapped.
    ulimit -v 8000000 2>/dev/null || true
    # cargo-mutants rebuilds once per mutant and dtolnay/rust-toolchain exports CARGO_INCREMENTAL=0
    # into GITHUB_ENV. Incremental cuts the game-core rebuild per mutant from ~15 s to ~4 s
    # (measured, same verdicts).
    export CARGO_INCREMENTAL=1
    echo "CARGO_INCREMENTAL=$CARGO_INCREMENTAL"
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
    # One rebuild per mutant: incremental, for the same reason as mutate-core.
    export CARGO_INCREMENTAL=1
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
    # round-robin: mutant i runs on shard i % n. The mutants whose tests run longest sit in the last
    # files (tactics*, trading*), so consecutive slices leave the last shards far slower.
    shard_args=(); [ -n "{{shard}}" ] && shard_args=(--shard "{{shard}}" --sharding round-robin)
    # Same runaway-allocation backstop as mutate-core (protects the 16 GB runner).
    ulimit -v 8000000 2>/dev/null || true
    # Incremental for the same reason as mutate-core: it cuts the server rebuild per mutant from
    # ~20 s to ~5 s (measured, same verdicts).
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

# The load driver for a few seconds: one level of 20 bots against the database MR_LOAD_DB (default
# monster-realm-load, kept apart from the dev database), which must already hold a published default
# module build. Needs a running SpacetimeDB (STDB_SERVER, default http://127.0.0.1:3000). Prints the
# JSON report on stdout and the level table on stderr, then exits non-zero when the run fails, the
# ramp aborts or the level is invalid (--fail-on-invalid).
load-smoke:
    cargo run -q -p sim-harness --bin mr_load_driver -- --server "${STDB_SERVER:-http://127.0.0.1:3000}" --db "${MR_LOAD_DB:-monster-realm-load}" --clients-start 20 --clients-max 20 --hold-scrapes 8 --scrape-interval-ms 1000 --run-id "$(date -u +%Y%m%dT%H%M%SZ)-load-smoke" --fail-on-invalid

# Build the load-only module (feature load_test_zones: game-core's 100 generated 16x16 zones, ids
# 10000-10099, and the dev reducer dev_place_in_load_zone) and publish it, data deleted, to
# MR_LOAD_HOST_DB (default monster-realm-load-zones) on STDB_SERVER (default
# http://127.0.0.1:3000). Then drive it, e.g. `cargo run -q -p sim-harness --bin mr_load_driver --
# --db monster-realm-load-zones --zones 100 --hot-zone 50 --walking-share 30 ...`. It is a dev build
# (every dev reducer is in it), so it publishes only to a database named monster-realm-load-zones*,
# only to an http(s) URL on a loopback host unless MR_LOAD_ALLOW_REMOTE=1, and builds in its own
# target dir so no default or e2e wasm is overwritten.
load-host:
    #!/usr/bin/env bash
    set -euo pipefail
    server="${STDB_SERVER:-http://127.0.0.1:3000}"
    db="${MR_LOAD_HOST_DB:-monster-realm-load-zones}"
    case "${db,,}" in
        monster-realm-load-zones*) ;;
        *) echo "load-host: refusing to publish the load build to '$db': the name must start with monster-realm-load-zones" >&2; exit 1 ;;
    esac
    case "$server" in
        http://*|https://*) ;;
        *) if [ "${MR_LOAD_ALLOW_REMOTE:-}" != "1" ]; then echo "load-host: STDB_SERVER '$server' is not an http(s) URL, so its host cannot be checked (set MR_LOAD_ALLOW_REMOTE=1 to allow)" >&2; exit 1; fi ;;
    esac
    hostport="${server#*://}"
    hostport="${hostport%%/*}"
    case "$hostport" in *@*) hostport="userinfo" ;; esac
    case "${hostport%:*}" in
        127.0.0.1|localhost|\[::1\]) ;;
        *) if [ "${MR_LOAD_ALLOW_REMOTE:-}" != "1" ]; then echo "load-host: refusing to publish a dev build to non-loopback '$server' (set MR_LOAD_ALLOW_REMOTE=1 to allow)" >&2; exit 1; fi ;;
    esac
    target_dir="${CARGO_TARGET_DIR:-target}/load-host"
    cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features load_test_zones --target-dir "$target_dir"
    spacetime publish -s "$server" --bin-path "$target_dir/wasm32-unknown-unknown/release/monster_realm_module.wasm" --delete-data -y "$db"

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
    # A production client needs a shell document: VITE_STDB_DB makes the build write
    # dist/shell-config.js naming the playtest DB, which `vite preview` then serves.
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

# Prove the built client/dist carries no DEV debug hooks and that its shell-config.js, and no
# other file, names $MR_PLAYTEST_DB.
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
