# ADR-0111 — PvP eval harness (battle_action privacy + handshake guards + liveness)

**Status:** Accepted
**Date:** 2026-07-14
**Slice:** m16c
**Supersedes:** —
**Amends:** ADR-0109 (M16a PvP spine) — adds the eval layer for PvP invariants
**Subsystems:** ci-gates, security-authz
**Decision:** Three `evals/pvp-*.eval.mjs` files: `pvp-action-privacy` (4 criteria), `pvp-handshake-guards` (11 criteria), `pvp-deadline-disconnect` (5 criteria). Proof-of-teeth per criterion. Evals-only; no prod code changes. M16 PvP CLOSED.

---

## Context

M16a (ADR-0109) shipped the PvP spine and M16b (ADR-0110) shipped the client UI. Both included Rust source-guard tests (`pvp_tests.rs`) that run in `cargo test`, but the project-wide JavaScript eval harness (`evals/run.mjs`) lacked PvP-specific coverage. M15c (ADR-0108) established the pattern: for each feature with critical security or liveness invariants, ship companion eval files that:

1. Check the same invariants as the Rust tests but via a different mechanism (JS string search, not Rust compilation), providing a second independent layer that can be run without compiling Rust.
2. Extend coverage to TypeScript client code that Rust tests cannot reach.
3. Use proof-of-teeth fixtures so CI can verify the checkers actually bite.

Three defect classes require eval coverage that the Rust pvp_tests.rs does not provide:

**Cross-language privacy** (`pvp-action-privacy`): `battle_action` must be private in both the server schema AND the TypeScript client. The Rust tests confirm `schema.rs` is correct but cannot check `connection.ts`. A developer copy-pasting the `battle_challenge` subscription block could accidentally add `battle_action` — a must-never-leak exploit. The JS eval checks both sides.

**Challenge lifecycle guards** (`pvp-handshake-guards`): The four challenge reducers (`challenge_pvp`, `accept_challenge`, `decline_challenge`, `cancel_challenge`) each require role-check + status-check + GC. Rust tests confirm the spine's structural wiring but don't audit each reducer's individual guard completeness with the teeth/fixture pattern. The JS eval mirrors the trade-reducer-security pattern (ADR-0108).

**Liveness invariants** (`pvp-deadline-disconnect`): The scheduler-only guard and stale-turn check in `pvp_deadline_reaper`, and the both-sides + cancel-outgoing-only patterns in the disconnect handlers, are tested in pvp_tests.rs as source-string checks. The JS eval independently re-verifies these using the same function-body extraction approach as the other evals, providing defense in depth.

## Decision

Ship three JS eval files following the ADR-0108 pattern:

- `evals/pvp-action-privacy.eval.mjs` — 4 cross-language criteria (schema.rs + connection.ts)
- `evals/pvp-handshake-guards.eval.mjs` — 11 challenge lifecycle guard criteria (includes CANCEL_DELETE after tester adversarial review)
- `evals/pvp-deadline-disconnect.eval.mjs` — 5 liveness criteria

Each criterion has a bad fixture (checker must flag) and a good fixture (checker must not flag) before the real source is scanned. No `new RegExp()` — all patterns use literal regex literals or `String.indexOf()`.

No changes to server code, schema, bindings, or `evals/run.mjs` (auto-discovery handles registration). This slice is evals-only.

## Consequences

- **Total eval count:** 61 (58 → 61; 3 new PvP-specific evals)
- **New defect class coverage:** 20 new criteria across 3 evals (CANCEL_DELETE added after tester review)
- **No schema change:** `battle_action`, `battle_challenge`, and `pvp_deadline_schedule` were added by ADR-0109 and remain unchanged
- **Tester review:** mandatory adversarial lens confirmed all proof-of-teeth bite correctly
- **M16 PvP CLOSED** (m16a spine + m16b client UI + m16c evals = complete)
- **ADR next-free:** 0112

## Considered alternatives

**No separate JS evals (rely only on pvp_tests.rs):** The Rust source-guard tests already cover the structural invariants. Adding JS evals adds maintenance surface. Rejected because: (1) the cross-language `connection.ts` check cannot be done in Rust; (2) defense-in-depth across two independent mechanisms is the established pattern (ADR-0108, ADR-0103); (3) the eval harness runs faster and without Rust compilation in CI.

**Single consolidated `pvp-security.eval.mjs`:** Merge all 20 criteria into one file. Rejected because the three defect classes are genuinely distinct (privacy, lifecycle guards, liveness) and separate files give clearer CI failure attribution.
