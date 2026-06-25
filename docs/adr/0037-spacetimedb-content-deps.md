# ADR-0037: SpacetimeDB module SDK + RON content dependencies

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context milestone:** M0b (the presence walking-skeleton vertical)
- **Implements:** ADR-0002 (SpacetimeDB 2.x), ADR-0006 (schema evolution +
  content-sync), ADR-0007 (zoned schema)

## Context

M0b stands up the first real SpacetimeDB module (the `presence` vertical) and the
data-driven content pattern. That needs the module SDK and a content parser.

## Decision

Add three workspace dependencies (SSOT in `[workspace.dependencies]`):

- **`spacetimedb = "1.12"`** — the module SDK. The crate version is independent of
  the product/CLI version: **crate 1.12 matches CLI 2.6.0** (confirmed against the
  working v1 reference `pokemon-mmo`, not memory). `server-module` depends on it
  directly; `game-core` will depend on it only behind its optional `spacetimedb`
  feature (for `SpacetimeType` derives) when shared row types arrive at M6.
- **`serde = "1"` (derive) + `ron = "0.8"`** — pure content parsing in `game-core`
  (`include_str!` + parse-don't-validate). No I/O, so it is safe under the
  determinism guard.
- **`log = "0.4"`** (server-module only) — the structured-logging facade the
  SpacetimeDB host captures (observability Layer 1: JSON reject lines with a
  correlation id, no PII).

## Consequences

- The module compiles on the host (`cargo check --workspace`) and to wasm via
  `spacetime build`; `server-module` stays a workspace member.
- The `sync_content` reducer is idempotent upsert-by-stable-id over the RON zone
  registry, separate from `init` and callable on republish (ADR-0006); the
  `presence` table carries an indexed `zone_id` (ADR-0007).
- Scheduled-reducer privacy is defended in depth (`ctx.sender != ctx.identity()`),
  per Tier-1 validation item #2 — verified empirically against the local instance.
- API syntax is pinned to crate 1.12 / CLI 2.6.0; bump deliberately (Renovate).
