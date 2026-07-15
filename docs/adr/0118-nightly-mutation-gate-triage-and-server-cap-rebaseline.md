# ADR-0118 — Nightly mutation-gate triage: check_headroom kill set, mutate-server cap re-baseline, wiring-eval ceiling raise

**Status:** Accepted
**Date:** 2026-07-15
**Slice:** nightly-mut-triage
**Supersedes:** —
**Amends:** ADR-0050 (A2 mutate-server survivor cap: 180 → 309; A3 wiring-eval cap ceiling: 200 → 340)
**Subsystems:** ci-gates
**Decision:** Kill the 5 check_headroom survivors with counterparty accept-boundary + guard-contract tests (no exclusions, no production edits); re-baseline mutate-server cap 180→309 (exact measurement); raise the wiring-eval ceiling 200→340.

---

- Status: accepted
- Date: 2026-07-15
- Milestone: nightly-mut-triage (Nightly RED Jul 10–15: jobs `mutation` + `mutation-server`)

## Context and problem statement

The nightly `mutation` (game-core, zero-tolerance per ADR-0050/ADR-0088) and
`mutation-server` (survivor-count ratchet, cap 180 per ADR-0050 A2) jobs were red
six consecutive nights (2026-07-10 → 2026-07-15; latest run 29403450612).
`coverage` and `smoke-republish` stayed green; master CI stayed green throughout.
Triage classified the two failures differently:

1. **`mutation` — class (a): missing tests.** Exactly 5 missed mutants on master
   `908c99b`, all in `game-core/src/trading/rules.rs::check_headroom` (M16.5b,
   ADR-0113):
   - `295:45 > → >=` (counterparty item-stack exceed check)
   - `309:80 > → >=` (counterparty balance exceed check)
   - `309:9 && → ||` (counterparty currency guard conjunction)
   - `302:36` and `308:39 > → >=` (the `*_receives_currency > 0` skip-guards)
   The M16.5b test suite pinned the reject side of every boundary and the accept
   side of the **initiator** branches only — the counterparty branches' accept
   boundaries were never pinned, so operator mutants there survive. The code
   itself is correct (`>` is right: a trade that exactly fills a stack/balance
   must be accepted; reject only on exceed — ADR-0113 reject-not-clamp).
   The 5 TIMEOUT mutants in `bin/tiled_import.rs` are pre-existing and tolerated
   iff missed=0 (ADR-0088 §3); no action.

2. **`mutation-server` — class (c): stale ratchet baseline (threshold drift), not
   weak tests.** A2's cap (180) is the exact missed count measured 2026-07-04 at
   `e875af0`, when the crate had **253 mutants (180 missed / 71% miss)**. Since
   then M15 (trading), M16 (PvP — whole new `pvp.rs`), and M16.5 merged, roughly
   doubling the crate: master `908c99b` measures **499 mutants (309 missed / 158
   caught / 32 unviable — 62% miss)**. The miss *ratio* improved while the
   absolute count grew — the growth is new reviewed feature code, not a test
   regression. Every one of the 309 survivors sits in a `#[reducer]` body or a
   `&ReducerContext`-taking helper (verified by signature audit: `has_active_trade`,
   `build_cards`, `find_fusion_recipe`, `now_ms`, `is_in_ongoing_battle`, … all
   take `ctx`); no `ReducerContext` is constructible in-crate, so the killable
   in-crate set is **empty**. Their behavioral coverage is the out-of-crate net
   A2 documents: reducer-security/escrow/conservation evals, integration, e2e
   (M15c, M16c, M16.5d added exactly those for the new code). The milestones that
   added the survivors simply never performed the deliberate re-baseline A2
   prescribes ("bump only deliberately, with the bump justified in a commit
   touching this ADR") — the gate is nightly-only, so slice CI never surfaced it
   (same mechanism as the ADR-0088 episode).

## Considered alternatives

- **Kill server survivors with in-crate tests.** Rejected: the killable set is
  empty (signature audit above). Faking it with mocked contexts is impossible
  (no constructor) and would be reward-hacking the count if simulated.
- **Extract reducer-body logic into game-core to make it killable.** Rejected for
  this slice: the pure decision logic is *already* extracted (`check_headroom`,
  `authorize_*`, `build_swap_plan`, `is_offer_stale` live in game-core under
  zero-tolerance); what remains in reducer bodies is DB plumbing. A speculative
  extraction refactor is out of scope for a triage slice and YAGNI.
- **Exclude the two `receives > 0` guard mutants via `.cargo/mutants.toml`**
  (ADR-0088 route). Rejected: (i) the ADR-0088 bar is "no test can distinguish" —
  here a unit test CAN distinguish (pure function; the full `u64` input domain is
  constructible in a test even where the wallet invariant `balance ≤ MAX_BALANCE`
  makes it unreachable in production); (ii) `mutate-core-recipe-integrity.eval.mjs`
  hard-pins mutants.toml to exactly three line-pinned entries with proof-of-teeth —
  the exclusion route would force a rewrite of that gate for a mutant a 10-line
  test kills.
- **Raise the mutate-server cap with headroom above the measurement** (e.g.
  cap 319 "for CI runner noise", proposed in plan review). Rejected: A2's ratchet
  posture is cap = exact measured baseline, so ANY new survivor reds the nightly
  and forces a conscious decision; headroom in the cap would let up to that many
  real survivors merge silently. The noise scenario it targets does not move the
  missed count anyway: a timeout on a slow runner makes cargo-mutants exit 3,
  which the `mutate-server` recipe fails LOUDLY on (it tolerates only exits 0/2)
  before any count-compare — headroom in the cap cannot absorb it. The server
  suite's per-mutant test time is ~0s (no timeout margin in play; 0 timeouts in
  every recorded run), and the exact-cap gate ran stably for 11 nights before
  the crate grew. Headroom lives in the wiring-eval *ceiling*, not the cap.

## Decision outcome

1. **game-core: 5 killing tests, zero exclusions, zero production edits.**
   Counterparty-side accept-boundary tests (exact stack fill; exact balance fill;
   nonzero in-cap currency) kill `295:45`, `309:80`, `309:9`. For `302:36`/`308:39`
   (the redundant-on-invariant skip-guards) two contract tests pass a deliberately
   out-of-invariant balance (`MAX_BALANCE + 1`) with `receives = 0` and assert
   `Ok`, pinning the guard's real semantics: **check_headroom polices the trade's
   delta, not pre-existing wallet state; a zero-receive side is exempt from the
   balance check.** Each test documents that its input violates the wallet
   invariant on purpose. Zero-tolerance on missed is unchanged.

2. **mutate-server: cap re-baselined 180 → 309** (`justfile` recipe default),
   the exact `just mutate-server` missed count measured on this PR's head —
   the same exact-baseline convention as the original 180. Justified by the
   evidence table above; this commit touches ADR-0050 A2 as its policy requires.

3. **Wiring-eval ceiling raised 200 → 340** (`evals/nightly-smoke-wiring.eval.mjs`
   `mutateServerRecipeIntact`): the ceiling exists to force an eval-visible,
   ADR-recorded ceremony for large cap moves while allowing small deliberate
   in-ceiling bumps; 340 preserves the original ~10% proportion (180/200) at the
   new baseline (309/340) and stays far below the TEETH-L-bigcap fixture (9999),
   which must keep biting. A ceiling of 500 was rejected: 191 survivors of silent
   headroom is a full M15+M16-scale growth cycle accreting without ceremony.
   A positive-control fixture at the new baseline value is added; no existing
   tooth is removed or weakened. The ceiling edit and the justfile cap edit land
   together (the ceiling first or same-commit — a cap above a stale ceiling reds
   `just eval`; the reverse order is safe: cap 180 ≤ ceiling 340).

4. **Re-baseline procedure recorded** (for the next server-growth milestone):
   run `just mutate-server` locally on the slice head (≈3 min on a dev machine);
   if the missed count exceeds the cap, verify the delta maps to the slice's new
   reducer surface (per-file diff of `mutants.out/missed.txt` against the previous
   baseline), then bump the cap to the new exact measurement **in the same PR**,
   amending ADR-0050 A2 with a dated line. A survivor increase inside OLD code is
   a test regression — investigate, don't re-baseline.

## Consequences

- **Positive:** both nightly mutation jobs return to green with their teeth
  intact (game-core still zero-tolerance; server still exact-baseline ratchet);
  the counterparty accept-boundaries of `check_headroom` are now pinned; the
  triage taxonomy + procedure turn the next nightly-red episode into a lookup
  instead of a re-derivation.
- **Negative / accepted:** cap-as-absolute-count still reds the nightly whenever
  server code grows — by design (forces the conscious ceremony), at the cost of
  recurring red episodes when a milestone forgets; the two out-of-invariant tests
  assert behavior on inputs production can't produce (documented in-test so a
  future reader doesn't "fix" the guard away).
- **Follow-ups (recorded residuals, deliberately not actioned here):**
  (1) the `mutate-server` recipe tolerates only cargo-mutants exits 0/2 — a
  timed-out server mutant would exit 3 and fail the job with a misleading
  "build/config error" message (fail-LOUD, so no silent hole; 0 timeouts ever
  observed on this crate; align with `mutate-core`'s ADR-0088 exit-3 shape only
  if it ever fires). (2) `mutate-server` lacks `mutate-core`'s explicit
  `[ ! -f missed.txt ]` guard — but a missing file yields empty `grep` stdout
  and `[ "" -gt ... ]` errors out under `set -e`, so this too fails loud, not
  vacuous-green. (3) `wc -l` (mutate-core) vs `grep -c ''` (mutate-server)
  count-idiom inconsistency is pre-existing and out of scope. If reducer-body
  survivor growth becomes noisy, a future ADR may revisit ratio-based ratcheting
  (miss% ≤ baseline%) — rejected for now as it can mask absolute regressions.
- **References:** ADR-0050 (+A2/A3), ADR-0088 (prior triage episode + equivalence
  bar), ADR-0113 (check_headroom semantics), nightly runs 29403450612 (Jul 15) /
  29086209572 (Jul 10, first red of the episode).
