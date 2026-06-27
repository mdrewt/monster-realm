set windows-shell := ["cmd.exe", "/c"]
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
# `mutate` (--workspace) so the scheduled run stays tractable; surviving
# mutants fail the job (default cargo-mutants behavior) — tighten/exclude
# equivalents as discovered (policy in ADR-0050). Runs in nightly.yml only.
mutate-core:
    cargo mutants -p game-core

# Nightly vitest line-coverage gate (ADR-0050). Self-contained: installs the
# coverage provider via --no-save (matching the pinned vitest 2.x) so it does
# NOT touch client/package.json, the lockfile, or vite.config.ts (M8.5d domain).
# vitest exits non-zero if line coverage falls below the threshold. Runs in
# nightly.yml only — NOT part of `just ci` (preserves the ADR-0043 fast loop).
coverage:
    cd client && npm ci && npm i --no-save -D @vitest/coverage-v8@2.1.9 && npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.thresholds.lines=25

build:
    spacetime build --module-path server-module

publish:
    spacetime publish --module-path server-module monster-realm

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

ci: lint typecheck test eval security wasm client-typecheck client-test
