# ADR-0039: Two-window e2e as a CI gate against a pinned standalone SpacetimeDB

- **Status:** Accepted
- **Date:** 2026-06-26
- **Context milestone:** M5b (the integration capstone — closes v1's largest CI blind spot)
- **Implements:** ADR-0009 (CI completeness — e2e in CI), ADR-0010 (proof-of-teeth),
  ADR-0012/0013 (prediction + smoothness)

## Context

ADR-0009 chose to run the two-window e2e in CI against a **containerized
`spacetime`**, ending v1's local-only e2e blind spot (a desync/stale-bindings
regression could ship green). M5a landed the e2e harness — Playwright, two browser
contexts, `window.__game()` state assertions, a `--delete-data` global-setup — and
it is green **locally**. M5b makes it a CI gate. ADR-0009 says "containerized"; this
ADR records the concrete realization and why it deviates from a literal service
image for now.

## Considered alternatives

- **Official image as a GitHub service container** (`clockworklabs/spacetime:<tag>`)
  — most literal reading of ADR-0009. Rejected for now: the image tag, default
  entrypoint/`start` args, and CLI⇄server version pairing are **unverified** from
  this environment, and the CLI must still be installed host-side to
  build/publish/`spacetime generate`. A version skew between a service-image server
  and the host CLI breaks the publish/generate protocol — the exact failure class
  M5b exists to prevent.
- **Pinned CLI + standalone instance on the runner (chosen)** — install the
  SpacetimeDB CLI, `spacetime version use 2.6.0`, `spacetime start --in-memory` on
  `127.0.0.1:3000`, then the existing `just e2e` flow (publish `--delete-data` →
  build module → Playwright two-window golden flows). One pinned toolchain for
  server, CLI, and the committed TS bindings — they cannot skew. This is exactly the
  flow verified green locally.
- **Keep e2e local-only (status quo)** — rejected: that is the v1 blind spot ADR-0009
  closes.

## Decision outcome

- Chosen: **pinned CLI + ephemeral standalone `spacetime` in the e2e CI job**, as the
  faithful realization of ADR-0009's "spacetime in CI" gate. The job pins **2.6.0**
  (matching the module SDK crate per ADR-0037 and the committed bindings), starts an
  in-memory instance, and runs the M5a golden flows headless on every PR and on
  `master`. `publish -s` takes a raw URL, so no server-alias registration is needed;
  the client's default `VITE_STDB_URI` (`ws://127.0.0.1:3000`) needs no override.
- **Falsifiability (ADR-0010):** `evals/e2e-desync-teeth.eval.mjs` runs in the cheap
  `just eval` gate every CI run. It (1) proves the canonical `predicted == authoritative`
  no-desync assertion **rejects** a known desynced fixture, and (2) asserts the `e2e`
  job stays **wired** in `ci.yml` (a silently dropped gate is caught).
- Consequences / follow-ups:
  - A TS-reimplemented rule, a stale-bindings publish, or a mid-batch reconcile
    rubberband now turns CI **red**, not just local `just e2e`.
  - **Follow-up (M5c):** the deferred M5 items — disconnect-despawn + reconnect-clean
    flows, and the **end-to-end smoothness** assertions (monotonic predicted tile;
    bounded remote frame-to-frame jump under injected jitter, ADR-0013) — land next;
    until then ARCHITECTURE states "e2e gates CI; smoothness-e2e + extra flows = M5c".
  - **Follow-up (ops):** revisit migrating to a verified official service-image once
    its tag + entrypoint + version pairing are confirmed; the job is structured so
    only the "start spacetime" steps change.
  - **Follow-up (settings):** mark the `e2e` status check **required** in branch
    protection (a repo-settings action, not expressible in the workflow). Until then
    the runner's merge discipline (merge only on green PR CI) enforces the gate.
  - **Residual CI risk:** a fresh runner has no SpacetimeDB identity; publishing to a
    local standalone server may need an identity-init step the local environment
    already had. If PR CI fails at publish, add the identity/login step — the local
    flow otherwise matches one-to-one.
