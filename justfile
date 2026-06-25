set windows-shell := ["cmd.exe", "/c"]
# Pure logic is testable offline; build/publish/integration need the spacetime CLI + an instance.

setup:
    cargo fetch --manifest-path server/Cargo.toml

lint:
    cargo clippy --manifest-path server/Cargo.toml -- -D warnings

typecheck:
    cargo check --manifest-path server/Cargo.toml

test:
    cargo test --manifest-path server/Cargo.toml

eval:
    @echo "eval: integration requires a running instance (spacetime start) — see README"

security:
    node scripts/check-secrets.mjs .

mutate:
    cargo mutants --manifest-path server/Cargo.toml

build:
    spacetime build --module-path server

publish:
    spacetime publish --module-path server monster-realm

changelog:
    git cliff -o CHANGELOG.md

ci: lint typecheck test eval security
