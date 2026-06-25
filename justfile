set windows-shell := ["cmd.exe", "/c"]
# monster-realm cargo workspace verbs. Pure logic is testable offline;
# build/publish/e2e need the spacetime CLI + an instance (see README).

setup:
    cargo fetch

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

typecheck:
    cargo check --workspace --all-targets

test:
    cargo test --workspace

eval:
    node evals/run.mjs

security:
    node scripts/check-secrets.mjs .

mutate:
    cargo mutants --workspace

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

# Regenerate the committed TS bindings from the module (bindings-drift gate checks these).
gen:
    spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings

# Multi-client e2e (real browser vs a running instance + published module).
e2e:
    cd client && npm run e2e

ci: lint typecheck test eval security
