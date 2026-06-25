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

ci: lint typecheck test eval security
