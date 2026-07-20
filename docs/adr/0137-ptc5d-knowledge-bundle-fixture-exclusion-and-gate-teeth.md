# 0137 — ptc5d: knowledge-bundle `*_tests.rs` exclusion + restored gate teeth (mutate-server ceiling tightened; RT-M14.5A-02 vacuous-pass closed)

**Status:** Accepted
**Date:** 2026-07-20
**Slice:** ptc5d (M-playtest-c.5 pre-gate residuals — tooling/eval hardening, EARS ptc5d-1..5)
**Supersedes:** —
**Amends:** ADR-0118 §3/A3 (wiring-eval cap ceiling: **340 → 299**, tightened to the committed cap so every cap move is eval-visible — reverses §3's ~10% headroom in favour of mechanical-enforcement-first, per the 2026-07-20 weekly review §5 item 5)
**Subsystems:** tooling-docs, ci-gates
**Decision:** Exclude `*_tests.rs` from the OKF bundle generator, assert no page is test-sourced, make RT-M14.5A-02's precondition an `assert!`, and tighten the mutate-server wiring ceiling 340→299 — each with a biting proof-of-teeth.

## Context

The eleventh weekly review (`0421f2c`, 2026-07-20) found four gate-integrity residuals at the seams between hardening waves — each a generated artifact or gating test whose own drift/precondition guard could not see its defect:

1. **The OKF knowledge bundle counts test-fixture reducers.** `scripts/okf-export.mjs` `collectRsFiles` (line 60) walks every `.rs` file under `server-module/src/` with no `_tests.rs` exclusion. `parseReducerMetadata` matches `line.trim().startsWith('#[spacetimedb::reducer')` (no column-0 requirement), so the inline `#[spacetimedb::reducer]` fixtures inside `ranking_tests.rs` / `playtest_tests.rs` are parsed as real reducers. Because pages are written into a `Map` keyed `reducers/<name>.md` and the alphabetically-later `*_tests.rs` file is pushed after its real sibling, `Map.set` **clobbers** the real page:
   - `docs/knowledge/reducers/set_profile_name.md` pointed at `server-module/src/ranking_tests.rs#L1396` (real: `ranking.rs#L139`, ADR-0132);
   - `docs/knowledge/reducers/playtest_reaper.md` pointed at `server-module/src/playtest_tests.rs#L957` (real: `playtest.rs#L158`, ADR-0131);
   - `schema-overview.md` claimed **49 reducers** (42 real). The knowledge bundle actively misled, and the conformance eval only checks `committed == regenerated`, so both agreed on wrong data — the drift gate was blind.

2. **RT-M14.5A-02** (`game-core/src/combat/redteam_m14_5a_tests.rs:443-452`) hit a bare `return;` before its sole assertion when its `status_applied` precondition was unmet — a regression that stopped `StatusApplied` emission would turn the test green while asserting nothing.

3. **The mutate-server wiring ceiling was 41 mutants looser than the committed cap.** `mutateServerRecipeIntact` (`evals/nightly-smoke-wiring.eval.mjs:318`) rejected only `cap > 340`, while the committed nightly cap is `mutate-server cap="299"` (justfile:83, the m17.5a re-measurement recorded under ADR-0118 §4). A silent bump of the justfile default from 299 up to 340 would have loosened the nightly survivor tolerance by ~41 mutants **without tripping the wiring eval**.

## Decision

### D1 — `collectRsFiles` excludes `*_tests.rs` (ptc5d-1)

Add `&& !entry.endsWith('_tests.rs')` to the file branch of `collectRsFiles`. Since `collectRsFiles` feeds **both** the per-file metadata loop and `readAllSources` (which feeds the SSOT `parseTableSchemas`), the exclusion propagates to the whole bundle. Empirically the filter changes **exactly 5** generated files — `index.md`, `reducers/index.md`, `reducers/set_profile_name.md`, `reducers/playtest_reaper.md`, `schema-overview.md` — restoring the real sources and the true **42**-reducer count. **Table-set-neutral by verified fact:** no `*_tests.rs` file contributes a table to `parseTableSchemas` (the table count is 34 both before and after the filter), so no real table is dropped.

**SSOT-comment reconciliation.** `readAllSources` previously carried the comment *"matches battle-schema-snapshot readServerModuleSources."* After the filter the bundle intentionally diverges: the knowledge bundle documents the **real** schema, while `battle-schema-snapshot.eval.mjs` (a separate drift gate) still concatenates all `.rs` files including tests. Both comments (okf-export.mjs:59 and :70) are updated to state the exclusion and the deliberate divergence, so no false claim remains. The shared parser (`parseTableSchemas`) still produces identical table output for both because test files define no real tables — the two gates diverge on the *file set*, not on the *table-definition subset*.

### D2 — conformance eval asserts no page is sourced from a test file (ptc5d-2)

`knowledge-bundle-conformance.eval.mjs` gains a pure predicate that, for every concept `.md` under `docs/knowledge/` (**reducers *and* tables** — symmetric, so a future test-file `#[spacetimedb::table]` fixture is caught too), scans each frontmatter line whose `trimStart()` begins with `resource:` or `source:` for the substring `_tests.rs`. Matching only those two key-prefix lines (not a blob `indexOf`) avoids a false-positive on an abstract/body that legitimately mentions a test file; requiring the `.rs` suffix avoids matching the `tags: [..., ranking_tests]` line.

**Proof-of-teeth is synthetic, not generator-derived.** The bad-fixture writes a temp concept file with `source: scripts/okf-export.mjs@server-module/src/ranking_tests.rs` and asserts the predicate **flags** it; the good-fixture uses `ranking.rs` and asserts it passes. This is a fixed predicate over a fixed fixture — it does **not** call `runExport()` (which, once D1 lands, would run the fixed generator and self-defeat the bad-fixture). A separate real-file check runs the predicate over the committed `BUNDLE_DIR` and asserts zero offenders — RED against the pre-D1 bundle, GREEN after regeneration.

### D3 — RT-M14.5A-02 precondition is now an `assert!` (ptc5d-3)

The `if !status_applied { eprintln!(...); return; }` block becomes `assert!(status_applied, "<forensic message with active/backup HP + events>")`, keeping the diagnostic detail so a genuine regression prints the same forensics. **Flake-safe by computed margin:** the scenario is fully deterministic (`always_hit_variance` + `no_block_sv` + fixed Sandstorm). The active monster (slot 0) has `current_hp = 3`; the wild's `burn_applying_skill` deals a computed **2** damage (base 2 → STAB 3 → neutral type → ×85/100 variance → 2 → neutral Sandstorm-vs-Fire), leaving **1 HP** — not fainted, so `StatusApplied` **is** emitted — and only then does the Sandstorm chip (`max_hp/16 = 16/16 = 1`) reduce it to 0 and auto-switch. `StatusApplied` therefore always precedes the faint; the sole existing assertion (backup slot 1 stays `None`, line 456) is unchanged. The scenario comment is tightened (the chip *kills*, not *could kill*) and notes the arithmetic dependency so a future damage-formula refactor updates the stats rather than silencing the assert.

### D4 — mutate-server wiring ceiling tightened 340 → 299 (ptc5d-4; amends ADR-0118 §3/A3)

Introduce `const MUTATE_SERVER_CAP_BASELINE = 299;` (module scope, citing justfile:83 / ADR-0118 §4) and change the ceiling check to `if (cap > MUTATE_SERVER_CAP_BASELINE) return false;`. The comparison stays `>` (not `>=`) so the committed `cap="299"` is accepted while `cap="300"` is rejected.

**This amends ADR-0118 §3/A3.** ADR-0118 raised the ceiling 200→340 to keep ~10% headroom above the cap, on the rationale *"Headroom lives in the wiring-eval ceiling, not the cap"* — permitting small in-ceiling cap bumps without an eval edit. The 2026-07-20 weekly review reclassified that 41-mutant gap as a **silent-loosening** risk and, per the project's mechanical-enforcement-first practice, directed tightening the ceiling to the committed cap so **every** cap move is eval-visible. Consequence, recorded here to update ADR-0118 §4's re-baseline procedure: a future legitimate server-growth re-baseline now bumps **both** the justfile `cap=` default **and** `MUTATE_SERVER_CAP_BASELINE` in the same PR (a small, deliberate, ADR-recorded ceremony — the coupling is the point). The `cap="9999"` TEETH-L-bigcap fixture still bites.

**Teeth updated in lockstep** (all in `nightly-smoke-wiring.eval.mjs`): the existing `TEETH L-recap` (`cap="309"`, previously asserted **accepted** under the 340 ceiling) is **flipped** to assert `cap="309"` is now **rejected**; a new `TEETH L-overcap` (`cap="300"` rejected) pins the +1 boundary; a positive control (`cap="299"` accepted) guards the `>`-vs-`>=` off-by-one; `TEETH L-good` (150) and `L-bigcap` (9999) are unchanged. The eight stale `≤ 340` comment/detail sites are updated to 299.

## Consequences

- **Positive:** the OKF bundle now documents real reducers with correct sources (F9/OKF-adoption deliverable is honest); a fixture-count regression now fails the conformance eval loudly (not just on `committed==regenerated`); RT-M14.5A-02 can no longer pass vacuously; a silent nightly cap loosening now trips `just eval`.
- **Negative / accepted:** the knowledge bundle's file set deliberately diverges from `battle-schema-snapshot`'s (documented in both comments + D1); future server-growth re-baselines edit one extra constant (D4). ADR-0118 A2 still records the cap as 309 while the justfile holds 299 (the m17.5a re-measurement under ADR-0118 §4) — that stale-doc reconciliation is a **pre-existing ledger residual** outside ptc5d's touch-set (justfile/ADR-0118 body unchanged here); flagged for the ptc5f ledger-reconciliation slice.
- **Scope:** tooling/evals/tests + regenerated `docs/knowledge/**` only. No schema, reducer, table, or game-rule change. No production-code behaviour change.

## References

- ADR-0080 (generated OKF knowledge bundle), ADR-0057 (schema-snapshot SSOT parser), ADR-0104 (ADR digest + canonical header).
- ADR-0118 (nightly mutation-gate triage; cap/ceiling re-baseline — amended here), ADR-0050 A2/A3 (mutation ratchet + wiring ceiling), ADR-0010 (proof-of-teeth discipline).
- Spec: `specs/monster-realm-v2/M-playtest-c.5-pregate-review-residuals.spec.md` §ptc5d.
