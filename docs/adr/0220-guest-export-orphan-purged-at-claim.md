# 0220 — A guest's pre-claim export chunks are DELETED at claim time in a delegated privacy.rs helper, keeping the REKEY_MANIFEST EXEMPT policy truthful

**Status:** Accepted
**Date:** 2026-08-31
**Slice:** rb-22 (residual R-m22-s2-S3-GUEST-EXPORT-ORPHAN)
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, schema-persistence, ci-gates
**Decision:** Pre-claim `export_bundle` chunks are DELETED at claim time by a delegated helper in the new owning module `privacy.rs`, keeping the REKEY_MANIFEST EXEMPT policy truthful; not re-keyed, not TTL-only.

---

## Context and problem statement

Residual R-m22-s2 identified a structural orphan: a guest who exports before claiming their account leaves `export_bundle` chunks under the guest identity. At `complete_guest_claim`, that guest identity retires and never maps to any account again. The S3 account-deletion cascade keys on the deleting account's own identity (schema.rs:1073-1079, data-lifecycle design spec M22 §3) and structurally cannot reach chunks owned by an identity that no longer maps to any live account.

The manifest's own HONEST LIMIT reason text (evals/guest-claim-integrity.eval.mjs:1864-1873) prescribes two options: "delete chunks at claim time, or sweep owner_identity == account.claimed_from in the cascade; the S4 TTL reaper does not exist yet and a TTL is not a substitute for cascade erasure anyway (the playtest_event doctrine)". This slice implements the first.

**Measured before authoring:** M22 shipped only S0/S1/S2 — no writer or reader of `export_bundle` exists anywhere in the tree (S4's `request_data_export` is unimplemented), so the premise "guest exports before claiming" is a structural hole ahead of S4, not a live-data bug today. The fix closes it at the identity-retirement point so S4 cannot land into the hole.

## Decision 1 — the fix is delegated to a new owning module privacy.rs

**Measured on the fork:** module-write isolation (G5, ADR-0056 D0) bans `export_bundle` writes in `accounts.rs`. The spec (M22 §7.2) assigns the entire export machinery to `privacy.rs` — the single module that will own `request_data_export` and its chunk logic in S4. Creating the module now ahead of S4 allows the claim-time purge to live in its assigned home, not accounts.rs, and ensures S4's machinery arrives pre-wired.

Consequence: `accounts.rs:1-30` documents this delegation at module scope; `accounts_tests.rs:2119` + the eval's `[W/*]` clauses enforce it; `privacy.rs:33-44` defines `pub(crate) fn purge_export_bundles(ctx, owner)`.

## Decision 2 — the helper is owner-generic for S3 cascade reuse

The signature `purge_export_bundles(ctx: &ReducerContext, owner: Identity)` collects `export_bundle` rows via the `owner_identity` btree index (ADR-0126 idiom, mirroring `disarm_claim_reaper` accounts.rs:321-335) and deletes each by PK. The body is frozen contract: `privacy_tests.rs` pins it byte-exactly in squashed form.

**Why owner-generic:** The M22-S3 account-deletion cascade will reuse the same helper verbatim for the deleting account's own chunks — `export_bundle` is `Erase`-policy in `DATA_LIFECYCLE_MANIFEST` (schema.rs:1073-1079), so it is part of the standard cascade, and the cascade itself is not scope-of-this-slice. The helper must answer the cascade's reuse pattern without modification.

**Consequence:** S3 still owns the full implementation of the cascade arm that calls this helper; this slice creates only the helper and the claim-time call site (accounts.rs:517).

## Decision 3 — Alternatives rejected

**Option A — re-key at claim (mirroring how other tables are handled):** Would falsify the EXEMPT policy entry (which prescribes deletion, not re-keying, and sits alongside other EXEMPT entries that do not re-key). Falsifying the policy forces edits to `evals/guest-claim-integrity.eval.mjs`'s POLICY_SHAPES/REKEY_MANIFEST sections — both outside the declared touches, creating a hidden dependency STOP. Additionally, re-keying would carry a stale pre-claim snapshot across an identity transition and risks collision with S4's chunk-tuple uniqueness (Guard 11 at accounts_tests.rs:2106-2108 never consults `export_bundle`, so a re-keyed pre-claim snapshot could collide with later S4-written chunks).

**Option C — TTL-reaper-only:** S4's reaper does not exist yet, and a TTL is not a substitute for cascade erasure — the playtest_event doctrine (spec M22 §3 rationale for why ERASE tables are not left to a reaper). The manifest's own reason text is explicit about this.

## Decision 4 — call site: between rekey_all and consume_claim_and_disarm

The purge is unconditional, happens exactly once, and sits at accounts.rs:517 — after `rekey_all(ctx, guest, me)?` (accounts.rs:512) and before `consume_claim_and_disarm(ctx, guest)` (accounts.rs:518). No `return` statement sits in the region (AUTH-34 single-use criterion, ADR-0106 D8). The transaction is atomic at the reducer level (spacetimedb 1.12.0 serialization guarantee).

## Decision 5 — scan hygiene contract for privacy.rs and privacy_tests.rs

The module enforces line-comment-only scan hygiene: no block comments, no raw strings, no logging or print macros, no escaped or char-literal double-quote. A dozen evals concatenate every source file in the crate (test files included) and strip comments naively with a regex; one unpaired opener silently blanks later modules from their view (recruitment/battle-lifecycle/practice-xp/migration-smoke-test/raising/battle/npc/no-idle-accrual/spacetime-type-snapshot/zone-warp/zoned-schema/battle-schema-snapshot, evals sorted alphabetically). The privacy* modules sort before pvp/raising/schema in that blob, so adversarial fixtures must be composed from `concat!()` fragments, never a contiguous `/*`/`*/`/`"` landmine (red-team MEASURED a full false-green on mock-fixture injection). `privacy_tests.rs` needs `#![cfg(test)]` and `privacy.rs` declares `#[cfg(test)] #[path = "privacy_tests.rs"] mod privacy_tests;`.

## The gate set

Sixteen gating tests (five accounts-arm + eleven privacy-arm including the crate-wide naming census) enforce the decisions: `rb22_claim_purges_guest_export_bundles_call_site` (exact squashed-form count==1, statement depth-0, ordering rekey_all < purge < consume < update < Ok, no `return`), `rb22_purge_called_exactly_once_in_accounts_rs` (whole-file count==1), `rb22_lib_wires_mod_privacy` (no cfg(test) guard), `rb22_privacy_module_purges_by_owner_index` (runtime read, fail-loud when absent), `rb22_accounts_header_names_the_privacy_delegate` (header truth), plus eleven privacy_tests.rs teeth verifying owner-scoped filter, btree-index shape, no-early-return, writes-only-export_bundle, no-identity-ctor, scan-hygiene self-test, stripper-machinery controls, and exact-body-equality pin (frozen contract, caught 25/25 mutants including dead-branch wrapping, shadowed IDs, aliased extra writes, and identity-shadowing). The pre-fix RED is captured at memory/projects/rb-22.red-before.txt (accounts_tests scans of ACCOUNTS_RS/LIB_RS + runtime read of privacy.rs when absent); EO-5's W1/W7/W17 mutants mechanically reproduce it on the shipped tree on every re-run.

## Honest limits / Residuals

1. **No LIVE behavioral proof exists.** No writer of `export_bundle` exists to seed rows (S4 unimplemented), the table is private with no reducer entry point, and the only live rig (evals/account-e2e.eval.mjs) is outside declared touches. Deferred (ledger EO-9 → backlog) to a cheap account-e2e phase once S4 ships `request_data_export`.

2. **The REKEY_MANIFEST reason text is stale.** evals/guest-claim-integrity.eval.mjs:1864-1873 still says "S3 MUST close this: delete chunks at claim time…", and rb-22 shipped exactly that fix, so the prose is now outdated. evals/ is outside rb-22's touches; a one-paragraph reason-text reconciliation (and the comment block at :1858-1863) belongs in a slice that owns that file. Deferred (ledger EO-10 → backlog).

3. **write_target_accessors has a statement-boundary blind spot.** Red-team measured a `let db = &ctx.db;` alias bypass at accounts_tests.rs:2139-2165 — a write verb not anchored to a same-statement `ctx.db.<table>()` chain is misattributed to the nearest earlier accessor or silently dropped. rb-22 closes the class for privacy.rs locally (hardened local port + alias bans + exact-body-equality pin in privacy_tests.rs), but the shared helper is pre-existing and lives in shipped tests. Changing it inside rb-22 risks false-REDs on accounts.rs's legitimate writes (the eval's own `[W/write-target]` comment notes Vec::insert-after-read shapes). Deferred (ledger EO-11 → backlog) — a dedicated hardening slice must re-baseline accounts.rs's existing write census against the stricter rule and port the eval's bans Rust-side.

4. **S3 still owes two things.** (a) the deleting-account erase of `export_bundle` in the cascade (this slice covers only the claim-time guest purge; the cascade itself is S3 scope); (b) the S4 still owes the TTL reaper AND must cap per-owner live chunk rows — an unbounded chunk count would let a guest inflate `complete_guest_claim` past the reducer budget, a self-denial that also makes the orphan unclosable (reducer-security-auditor Q5 from the attack-surface review).

5. **The scan machinery's char/byte-literal brace blind spot is pre-existing.** (Noted, not fixed: a character-literal double-quote `'"'` blinds the comment/brace stripper to everything after it in the same line; extraction returns None = loud, so a gate that catches it will red, but a gate that silently drops it will ghost-pass. Measured and accepted as a known gap — closing it requires a full state machine, not a regex, and privacy_tests.rs avoids the shape entirely, per scan-hygiene contract.)

6. **The crate-wide naming census deliberately uses NO word boundaries.** An aliasing `use ... as p` fuses to `_bundlesasp;` and the declaration fuses to `pub(crate)fnpurge...` — either boundary drops a real occurrence site. The accepted cost is a loud false-RED on a longer same-prefix identifier that comes too close (e.g., a later module declaring `pub(crate) fn purge_something_else`). The test `rb22_privacy_module_purges_by_owner_index` will catch this and fail audibly.

---

## Consequences

- A new module `privacy.rs` is created as the assigned home for all export machinery, closing a structural gap ahead of S4 and ensuring the claim-time purge has a permanent address.
- The `REKEY_MANIFEST` entry for `export_bundle.owner_identity` is now truthful: it claims EXEMPT with a prescription, and the prescription is fulfilled.
- Module-write isolation (G5, D0) is enforced: `export_bundle` writes in `privacy.rs` only; `accounts.rs` writes only its three owned tables.
- The helper is designed for S3 cascade reuse, but the cascade call site is outside this slice's scope — a later S3 slice will invoke it.
- S4's export machinery lands into a pre-wired owner module, closing the invitation for a misplaced export-table write at claim time or elsewhere.
- The scan-hygiene rules for privacy* modules are strict and documented, preventing a subtle false-green in evals that concatenate .rs files naively.
