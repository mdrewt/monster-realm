# 0178 — Validator & core hardening tail: R4 gate semantics, single duplicate-pair enforcement, ids-only party seam, cap-exhausted write elision

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-e (M-postgate-twelfth-review-residuals)
**Supersedes:** —
**Amends:** ADR-0174, ADR-0175
**Subsystems:** evolution-fusion, content, movement-netcode
**Decision:** R4 tests vacuity against `path_satisfied`'s own thresholds; `sync_content`'s unreachable duplicate-pair re-scan is deleted; the movement growth tail takes an ids-only party helper; and a cap-exhausted Quality-Time call writes no row.

## Context

The twelfth post-gate review found four independent, individually-cheap defects in the
essence-graph validator and its reducer tail. All four were verifier-confirmed real and all
four were verifier-downgraded to Low: **none is a live bug at this SHA**. Each closes a trap
— a guard that does not guard, a comment that lies, a silent failure mode, a wasted write —
rather than a wound. They are bundled into one slice because each is too small to be one.

Three of the four touch decisions already recorded in ADR-0174 (EG1 schema/type freeze) and
ADR-0175 (EG2 reducers), which is why this ADR amends both rather than standing alone.

## D1 — R4 tests whether a gate can EXCLUDE, not whether a field is present

`validate_evolution_paths`' R4 ("no vacuous path") rejected an edge only when
`min_level <= 1 && essence.is_empty() && min_trust_tier.is_none() &&
min_quality_time_tier.is_none() && min_nutrition_pct.is_none()`. Four encodings are
structurally "present" and semantically no gate at all, because each is the **minimum of its
own comparison** in `path_satisfied` (`game-core/src/evolution/eligibility.rs`):

| encoding | why it gates nothing |
|---|---|
| `essence` entry with `amount: 0` | `essence_gate_met` compares `have >= req.amount` on a `u32` |
| `min_trust_tier: Some(TrustTier::Hostile)` | `Hostile` is the lowest `Ord` variant (ADR-0174 D4) |
| `min_quality_time_tier: Some(0)` | tier range is `0..=4` |
| `min_nutrition_pct: Some(0)` | range is `0..=100` |

Any one of them makes R4's `&&` chain false while `path_satisfied` returns true for **any**
monster — so under EG2-11 auto-evolution the edge fires at monster creation with no player
action, which is precisely the failure R4 exists to prevent. R4 now rejects unless at least
one gate is **binding**, testing each slot against the same threshold its `*_gate_met` twin
uses. Shipped content is unaffected (all ten edges in `000-core.ron` carry `min_level > 1`,
a non-zero essence amount, or `Some(Friendly)`).

**Rejected alternative — evaluate `path_satisfied` against a synthetic floor monster in
production.** It removes the duplicated comparison knowledge, but `trust_tier_of(0, 0) ==
Neutral` (the Bayesian midpoint, ADR-0174 D4), so a zero-history monster is not the weakest
representable one, and the rule would silently become "no monster qualifies **at birth**" —
a strictly larger rejection set than the four encodings above, forbidding legitimately-gated
content. The floor monster survives where it belongs: as the test oracle (D1a).

**D1a — the drift gate.** `r4_vacuity_floor_agrees_with_path_satisfied_for_the_weakest_representable_monster`
asserts the biconditional `path_satisfied(weakest, path) == validate(..).is_err()` over a
fixture table. The weakest **representable** monster needs `trust_unfavorable_count: 14`
(ADR-0174 D4's "Hostile at 14 net unfavorable"), pinned explicitly because it is the one
non-obvious number a future reader would "simplify" back to 0. This is the only test that
catches drift between the vacuity floor and the gate comparisons — the exact bug class D1
fixes — and it is why the floors are not merely hand-copied constants.

**Disclosed residual — the at-birth gap is NOT closed.** `min_trust_tier: Some(Wary)` and
`Some(Neutral)` are binding in R4's sense (they exclude a monster whose smoothed Trust is
Hostile) yet a newborn already satisfies them, so such an edge still auto-evolves at
creation. Closing that needs a `> Neutral` floor, which rejects content encodings the 12r-e
spec does not sanction; it is a deliberate scope boundary, disclosed here and in the test
that pins the accepted `Some(Wary)` row so the row is not misread as an endorsement.

**Disclosed residual — the dual, upper-bound hole.** `min_quality_time_tier: Some(5..=255)`
and `min_nutrition_pct: Some(101..=255)` are representable while `quality_time_tier_of`
saturates at 4 and `nutrition_pct_of` caps at 100, producing a permanently **unsatisfiable**
edge that R4, R10 and every other rule accept — so R10 certifies a species reachable while
it is unobtainable forever. Roughly six lines in the same predicate whenever it is scheduled;
out of this slice's EARS scope.

**Disclosed residual — R4 now has three implementations, and two still use the old
semantics.** `evals/evolution-content-integrity.eval.mjs`'s `checkR4Vacuous` is an
independent JS re-implementation over the same RON bytes and is now strictly **weaker** than
the Rust validator (it accepts a degenerate edge the validator rejects); it is the gate
content authors actually run at dev time. `game-core/tests/eg3_evolution_graph.rs`'s T11
hand-rolls a third field-presence copy. Both files are outside this slice's declared
`touches:` set, so both are named here rather than edited — porting the binding-gate
predicate into `checkR4Vacuous` is the follow-up that matters.

## D2 — Duplicate-pair rejection has exactly ONE enforcement point (amends ADR-0174 D5)

ADR-0174 D5 recorded that R1 "is enforced ONLY by `validate_evolution_paths` at the content
gate **plus `sync_content`'s duplicate-pair seed check**". The second checkpoint was
unreachable: it ran immediately after `validate_evolution_paths` returned `Ok`, over the same
unmutated `Vec`, in the same function, with nothing in between — and game-core's R1 is the
identical algorithm on the identical key. Its comment nonetheless called itself "the LAST
line of defense against a duplicate edge reaching the DB". **It is deleted. R1 at the content
gate is the single enforcement point its own comment already claimed to be.** D5's remaining
substance — no composite unique index exists, so there is no DB-level backstop, and EG1-12's
contingency stands — is unchanged.

**Rejected alternative — move the check post-insert, against the written `evolution_path`
rows.** That would be a real trust boundary, but it can catch nothing here: the write phase
fully clears the table and then applies a **total 1:1 map** from the validated `Vec` to rows
(`path_id` is DB-internal `auto_inc`; `edge_id`/`from`/`to` are copied verbatim), and
`ctx.db.evolution_path().insert(` occurs at exactly one site repo-wide, fed by that same Vec.
The written pair-multiset is by construction the image of an already-validated one. It is
also untestable except tautologically — producing a duplicate the validator did not see
requires mutating the twenty lines directly above the check — and a test that cannot fail is
worse than no test. It would additionally cost a full `evolution_path` scan on every `init`
and `sync_content`.

**This deletion is recorded deliberately so it is not "hardened" back in.** Re-adding a
second in-function scan is the failure mode this whole residuals milestone exists to break.

**Disclosed residual:** `server-module/src/schema.rs`'s R1 inventory note repeats D5's now-false
"plus the `sync_content` duplicate-pair seed check" wording. `schema.rs` is outside this
slice's `touches:`, and — because `scripts/okf-export.mjs` stamps every generated knowledge
page from `gitDate(schema.rs)` — touching it for a comment would restamp the entire bundle.
Left stale, named here.

## D3 — The growth tail takes an ids-only party seam (closes ADR-0175 Consequences (4))

`lead_party` parsed the LEAD monster's level with `Level::new(lead.level).ok()?`, returning
`None` for the **entire** party on failure, silently. Pre-EG2 that only silenced a wild-
encounter roll; EG2 added the `enqueue_move` consumer that drives `accrue_quality_time` +
`check_and_evolve` for every party monster, so the blast radius became "all Quality-Time and
auto-evolution progress for that player, on every move, forever".

**Reachability, stated honestly: not currently reachable.** Every writer of `Monster.level`
at this SHA passes through `Level::new` or an already-`Level`-typed value (`marshal.rs`,
`battle.rs`, `evolution.rs`, `taming.rs`). This is defense-in-depth against a future writer
or a migration/corruption event, not a live defect.

`lead_party_ids` is now the **base** helper — query, sort by `party_slot`, collect ids; it
parses no level and cannot fail for a non-empty party — and `lead_party` delegates to it,
point-reading the lead row for the level. **The dependency direction is load-bearing and is
scan-pinned.** The reverse shape (`lead_party_ids` as a thin wrapper over `lead_party`) was
PoC'd during review: it satisfies every naive scan while changing nothing, leaving the whole
party still disabled by a bad lead level. So is a level check moved one call deep, or moved
out to the caller. The gating tests pin the base helper's return as unconditional given a
non-empty party, and pin `enqueue_move`'s body to contain no `Level` at all.

The failure path now emits `log::warn!` so it can never be silent again — **rate-limited**,
because `lead_party` is reached per character per tick from the scheduled `movement_tick`,
where an unlimited warn is a log flood (the ADR-0170 D4 limiter idiom the same file already
uses for encounter-table errors). "Never silent again" must not become "never quiet again".

`Option<Vec<u64>>` is kept rather than a bare `Vec` so `enqueue_move`'s `if let Some(..)` arm
survives: a caller with no party still pays zero `trade_offer` index reads on the hottest
reducer in the game. `Some` is never empty.

## D4 — A cap-exhausted Quality-Time call writes no row (amends ADR-0175 D1)

Once `creditable == 0` — the 2 h `QT_DAILY_CAP_MS` daily window is exhausted —
`apply_quality_time_credit` re-anchored and returned `true`, so `accrue_quality_time`
performed an unconditional `monster` row update that changed only an invisible clock anchor:
no tick, no tier change, nothing `check_and_evolve` can observe. On `enqueue_move`, one
wasted row write per party monster per ~5 s of active play for the rest of the UTC day. **It
now returns `false` without re-anchoring.**

**Why this drops exactly one mutation.** `creditable == gap.min(headroom)` with
`gap >= QT_MIN_WRITE_GAP_MS > 0`, so `creditable == 0 ⟺ headroom == 0 ⟺ window_ms >= CAP`.
But the UTC-day rollover branch sets `window_ms = 0` ⇒ `headroom == CAP` ⇒ `creditable > 0`.
**The rollover branch and the capped branch are mutually exclusive**, so returning early can
never suppress a day reset — the ordering hazard ADR-0175 D1 calls load-bearing is untouched.
Independently verified by exhaustive simulation over ~500M call evaluations: never violated.

**Rejected alternative — gate the caller's write on `ticked`.** It would also suppress the
two branches whose entire purpose is to persist an anchor with no tick: the backwards-clock
re-anchor (a future anchor would never be cleared → permanent accrual lockout) and the
idle-gap re-anchor (the anchor would never advance past an idle period, so every later call
re-takes the idle branch → **Quality Time dies permanently after the first log-off**). Note
the daily cap itself stays enforceable under either option — `gap` is measured from the
un-advanced anchor and grows monotonically — so the cap is not the reason; the anchor
branches are.

**Honest residuals.** (1) Writes on a capped, actively-playing monster drop to roughly one
per `QT_IDLE_GAP_MS` rather than to zero, because the idle branch still re-anchors — that
branch is what keeps anchor staleness **bounded**, and the bound is now pinned by test.
Measured over a realistic four-hour capped session straddling midnight the reduction is
~1.9×, not the ~24× that holds only strictly inside the capped window. (2) With the anchor
frozen, a UTC rollover can shift credit by up to **±4 QT ticks** (measured by exhaustive
search, minimised witness recorded in the test doc) — in *either* direction, because a stale
anchor can carry genuine pre-midnight playtime into the new day or push the first
post-rollover call into the idle branch. The pre-existing `daily_cap_stops_credit` test
asserted the opposite behaviour and named the under-credit direction in its own rationale:
that rationale is **bounded, not refuted**, and the rewritten test says so rather than
claiming the anchor is not load-bearing.

## Consequences

- **`daily_cap_stops_credit` was inverted, not strengthened.** Its no-credit content is
  identical before and after; the write/anchor assertion is a deliberate directional reversal
  justified by D4, and the property it dropped (a capped-and-active row's anchor tracks the
  clock) is re-pinned tightly by a new sibling test bracketing both sides of
  `QT_IDLE_GAP_MS`. Recorded explicitly because inverting a teeth test is the
  highest-scrutiny move in this slice.
- **E2 and E3 have no executed `ReducerContext`-level proof.** No such test harness exists in
  `server-module`. E2 is proven by source scans over the real sources plus the structural
  shape of the seam; E3 by unit tests on the pure `apply_quality_time_credit` seam plus a
  scan proving the shell returns before its row write. Both are labelled in-test as
  structural rather than behavioural. This is the honest limit, not a claim of coverage.
- Four residuals are deliberately left and named above: the R4 at-birth gap (D1), the R4
  upper-bound hole (D1), the two out-of-scope R4 mirrors in `evals/` and `game-core/tests/`
  (D1), and `schema.rs`'s stale R1 comment (D2). The eval mirror is the one that matters
  most — it is the dev-time content gate and it is now weaker than the validator.
