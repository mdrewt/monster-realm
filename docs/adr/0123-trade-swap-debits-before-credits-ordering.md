# 0123 — Trade swap debits-before-credits ordering: apply-order contract + netted currency headroom

**Status:** Accepted
**Date:** 2026-07-18
**Slice:** m17.5b (M17.5 tenth-review residuals §17.5b — trade same-item near-cap conservation)
**Supersedes:** —
**Amends:** ADR-0113 (receiver-cap headroom — currency balances now netted symmetrically with item stacks; `check_headroom` itself unchanged)
**Subsystems:** economy-quests, security-authz
**Decision:** Debits-before-credits via the published `SwapPlan::ordered_steps()` contract, plus currency headroom netted (balance − own outgoing) like items: the ADR-0113 check becomes exact and no swap can hit a transient over-cap clamp.

## Context

**The bug (17.5b, HIGH→MEDIUM):** `confirm_trade` applied each item transfer as `consume_one(from)` then `grant_item(to)`, in `build_swap_plan`'s initiator-items-first order. On a same-item bilateral swap the counterparty's CREDIT (transfer 1) landed before its DEBIT (transfer 2). `grant_item` monotone-clamps at `MAX_ITEM_STACK = 9999` — a grant to a stack at cap is dropped entirely, silently. The ADR-0113 item-headroom check was *already netted* (`raw_count − sending_qty`) and therefore correct **only under debits-first apply semantics** — the apply order was the bug, not the check. Repro: counterparty at 9999 of X; offer gives 15 X, takes 20 X → netted headroom sees 9999−20+15 = 9994 ≤ 9999 (passes) → apply drops the +15 at cap, then debits 20 → 9979; 15 destroyed with no error.

**The currency analog:** the headroom call passed RAW `wallet_balance` values, un-netted. `validate_proposal` permits currency on both sides, so a bilateral currency swap near `MAX_BALANCE` was **falsely rejected** (raw balance + incoming > cap even when the net is legal). That same un-netted strictness *masked* the equivalent currency destruction (`apply_grant` saturates at `MAX_BALANCE`): a receiver near cap was rejected before the clamp could destroy value. **The two fixes are inseparable** — netting the currency inputs (17.5b-2) without debits-first (17.5b-1) would have *introduced* currency clamp-destruction on the same credit-before-debit window.

## Decisions

### D1 — `SwapPlan::ordered_steps() -> Vec<ApplyStep>` is the SSOT ordering contract (game-core)

```rust
pub enum ApplyStep {
    ItemDebit      { from_initiator: bool, item_id: u32, qty: u32 },
    CurrencyDebit  { from_initiator: bool, amount: u64 },
    ItemCredit     { to_initiator: bool, item_id: u32, qty: u32 },
    CurrencyCredit { to_initiator: bool, amount: u64 },
}
```

`ordered_steps()` emits ALL debits, then ALL credits. Contractual guarantees (all executed-tested):
strict debit/credit phase partition; per-transfer exact parity (every transfer yields exactly one
debit and one credit with identical `item_id`/`qty` or `amount`); within each phase, item steps in
`item_transfers` order then currency steps in `currency_transfers` order. This is a **first-class
published game-core API with the same SSOT standing as `check_headroom`** — do not demote or
internalize it without superseding this ADR. Debits-first is what makes the netted headroom check
exact: any plan that passes the check applies without ever touching a cap, preserving
reject-not-clamp (ADR-0113).

### D2 — Currency netting is shell-side, inline in the `check_headroom` arguments

`confirm_trade` passes `wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency)`
(and the counterparty twin) — each party's OWN outgoing subtracted from their OWN balance — inline
as the balance arguments. Netting stays shell-side for the same reason the m16.5b item netting is
shell-side: `check_headroom` is a pure receiver-centric checker that trusts its inputs; moving
netting inside would change its 8-arg signature and its entire test surface for no SSOT gain (the
*rule* — reject-not-clamp — already lives there once).

**Cap-headroom-only semantics (deliberate):** `saturating_sub` floors at 0 when outgoing exceeds
the live balance (reachable — `heal_party`/shop spends can land between `propose_trade` and
`confirm_trade`; the one-active-trade rule blocks only other trades). The headroom check may
therefore pass a broke sender; the rejection site is `spend_currency` Err inside the step loop →
**whole-transaction rollback via SpacetimeDB reducer-Err atomicity** (monster writes preceding the
step loop roll back too). This is a platform guarantee this design leans on deliberately; it is
documented, not unit-exercised. Affordability was never `check_headroom`'s job — the division of
labor is unchanged by this slice.

### D3 — Credit variants carry `to_initiator` (receiver-named); inversion happens once, at emission

`ordered_steps()` computes `to_initiator: !xfer.from_initiator` when emitting credits. The shell
match then reads both flags DIRECTLY — `from_initiator` on debit arms, `to_initiator` on credit
arms — with **no inversion at any dispatch site**. A sender-named flag on credit variants would
force every dispatch site to invert mentally and in code; that inversion is exactly the
recipient-swap bug magnet the plan-review fan flagged (B-1/F2/F5). The per-party executed
conservation tests pin the emission-side inversion.

### D4 — The shell is one exhaustive 4-arm match

`confirm_trade` has a single `for step in plan.ordered_steps()` loop with an exhaustive match (no
wildcard) dispatching to the fixed single-surface primitives `consume_one` / `spend_currency` /
`grant_item` / `grant_currency` (ADR-0018/ADR-0081 disciplines unchanged). The legacy per-transfer
loops are deleted. Monster transfers are ownership flips with no cap — they stay in their own
prior loop, outside `ApplyStep`, before the step loop. A new `ApplyStep` variant compiler-flags
the shell match (illegal states unrepresentable at the dispatch layer).

### D5 — Enforcement (proof-of-teeth inventory)

- **Executed (game-core `rules.rs` tests):** walk the REAL `ordered_steps()` over a per-party
  clamp-mirror model whose credit op asserts **before** clamping (tripwire: a credit that would
  exceed cap panics rather than being absorbed). Cases: same-item bilateral swap with receiver at
  9999 and 9998 → conserved exactly per-party and aggregate; genuine over-cap net → `check_headroom`
  Err before any walk; currency netting asymmetric-sensitivity case whose outcome FLIPS if the two
  subtrahends are swapped; broke-sender boundary (netted 0 passes cap-wise, doc-names
  `spend_currency` as the rejection site); constructive proptest (no `prop_assume`) over the
  near-cap region; partition + per-transfer parity + zero-currency phantom-step teeth.
- **Source-guard (`trading_tests.rs` EA-CONSERVATION-ORDER-01):** on the comment-stripped,
  string-stripped, whitespace-normalized `confirm_trade` body: loop-consumption needle
  (`for … in plan.ordered_steps()` — a discarded call fails), NEGATIVE legacy-loop needles, and
  both netting expressions required INSIDE the `check_headroom` argument span (kills the
  dead-variable bypass and the field-swap). Teeth fixtures: discard, split-loop, dead-var/swapped
  netting — each demonstrably fails. EA-CONSERVATION-ORDER-INLINE-01 pins the *inline-expression*
  gate constraint explicitly: a semantically-correct named-variable refactor fails the span check
  by design and must update the gate alongside the refactor.
- **Eval (`trade-conservation.eval.mjs` APPLY_ORDER, 8th criterion):** source-scan mirror of the
  positive/negative/netting-span needles with its own bad-fixture teeth; string-literal stripping
  added to the shared extraction pipeline.
- **Mutation:** targeted cargo-mutants on `ordered_steps()` — 0 missed (empty-vec mutant and both
  `to_initiator` inversion-deletion mutants caught).

### D6 — Residual: the check↔apply pairing is not type-enforced

Any future caller of `ordered_steps()` must run the netted `check_headroom` first; the type system
cannot enforce the pairing (no linear types). Mitigation: the `ordered_steps()` rustdoc states the
obligation, this ADR records it, and the source-guard pins the pairing for `confirm_trade` — a new
executor added without the check is a review-time catch (security-lens forward obligation).

### D7 — Rejected alternatives

- **Split debit/credit `Vec` fields on `SwapPlan`:** breaks every existing `item_transfers`/
  `currency_transfers` consumer; four loops cannot be observed as one ordering contract.
- **Shell-only loop reorder pinned by source-scan:** the spec mandates *executed* regression tests
  for 17.5b-3; a reorder mutant would have no executed test to kill it.
- **Fallible `grant_item_exact`/`grant_currency_exact` (reject-not-clamp belt-and-braces):**
  touches the frozen single-surface files (`inventory.rs`/`economy.rs`) and does not fix the
  currency false-reject; debits-first fixes both.

## Consequences

- Same-item near-cap swaps conserve exactly: with debits-first, a netted-headroom-passing plan
  never engages any clamp at any intermediate step.
- Cap-adjacent bilateral currency swaps with a legal net are no longer falsely rejected.
- A broke sender (post-propose spend) passes the cap check and rejects at `spend_currency` with
  full rollback — unchanged behavior, now documented instead of implicit.
- The apply order is executable, testable data — regressions require changing a published contract
  with its own executed teeth, not just reordering two loops.

## Residuals / follow-ups

- `consume_one` is O(qty) DB ops per item debit (pre-existing, bounded by `MAX_ITEM_STACK` 9999);
  candidate follow-up: a `consume_qty` primitive in `inventory.rs`.
- Shop `buy`/`sell` still lack receiver-cap headroom rejects — that is slice 17.5c, not this ADR.
- The netting-needle gate requires the INLINE argument form; a named-variable refactor must update
  EA-CONSERVATION-ORDER-01 (and the eval twin) in the same change — pinned by
  EA-CONSERVATION-ORDER-INLINE-01 with an explanatory failure message.
