# ADR-0252 — `cancel_account_deletion` declines the incoming trade offers its own deletion gate refused; the request stamp still clears

**Status:** Accepted
**Date:** 2026-09-12
**Slice:** rb-83 (residual R-rb-47-CANCELLAUNDER, `M-residual-backlog.spec.md#rb-83`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0237 (rb-47 — the stamp-aware accept gate; reciprocal `Extended-by:` in its header, and its CANCELLAUNDER residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, economy-quests
**Decision:** Cancelling a deletion declines every active offer naming the caller as counterparty that the rb-47 stamp gate refused for the pre-cancel row; the stamp still clears (AUTH-29/PRV1-3) and a re-request still restarts the full grace.

---

## Context and problem statement

ADR-0237 (rb-47) gates the accept path of `respond_trade` on the offer's creation stamp: a deletion-gated
counterparty D cannot accept an offer created at or after D's own deletion request (`guards::require_commitment_predates_deletion`,
`trading.rs:468`, delegating through `accounts::refuses_commitment_opened_at` into the pure
`accounts::opened_commitment_is_refused`). Its Consequences recorded Flow B as residual R-rb-47-CANCELLAUNDER:
D cancels the deletion — `cancel_account_deletion` (`accounts.rs:906-936`) flips the row to `Active` and clears
`deletion_requested_at_ms` — accepts the confederate C's post-request offer while Active, lets C confirm, and
re-requests deletion. A second ordering is worse: D cancels, re-requests at once (a FRESH, later stamp `t2`), and
accepts mid-grace, because the gate now compares the offer against `t2` and the post-request offer reads as
predating the request. Either way the reference point of the rb-47 gate is reset by the gated party at will, at
the cost of two reducer calls and a few seconds of elapsed grace.

The residual was filed as "spec-change class" with the deferred reason "only a policy that binds a re-request to
the ORIGINAL deadline would close it". That mechanism — retaining the request stamp across a cancel — was measured
against the code and the spec before planning and conflicts with four things at once: M21 **AUTH-29** and M22
**PRV1-3** both say a cancel SHALL *clear* `deletion_requested_at_ms`; ADR-0195 D3's legal-state predicate
(`account_state_is_legal`, `accounts.rs:161-176`) makes `Active` + a stamp an illegal, `debug_assert`-guarded
shape; `game_core::is_deletion_due(None, _) == false` is documented as load-bearing on PRV1-3 clearing the stamp;
and the stamp is exposed to the client through the `my_account` view and to the data subject through the PRV1
export bundle (`privacy.rs:961-980`), so a retained stamp on an `Active` row would misreport the account's state.
The additive alternative — an earliest-ever anchor column on `account` — is a schema slice (bindings regeneration,
the table-schemas baseline, every `Account { .. }` literal in six test files), all outside this slice's declared
touches. Binding the re-request to the original deadline is therefore not a bounded hardening fix here.

## Decision

### D1 — Pure planner: `accounts::plan_declines_at_cancel(&Account, &[(u64, i64)]) -> Vec<u64>`

Given the caller's row **before** the cancel writes it and the caller's live incoming offers as
`(trade_id, created_at_ms)` pairs, return, in input order, the ids of every offer that
`opened_commitment_is_refused(account, created_at_ms)` refuses. Composed DIRECTLY over the rb-47 SSOT — the
comparison, the inclusive boundary, the terminal arm and the fail-closed `None` arm are all inherited, never
re-derived (ADR-0225, ADR-0237 D1). On the illegal stamp-less `PendingDeletion` shape the SSOT refuses at every
stamp, so every incoming offer is swept: the fail-closed direction. On an `Active` row the SSOT admits everything,
which is the second reason (after placement) that the sweep can never fire on the AUTH-38 no-op path. Mirrors the
`plan_deletion_rearms` shape (a pure filter/map over rows, executed in tests by truth table).

### D2 — Two plain trading-side functions, no closure

`trading::open_offers_addressed_to(ctx, counterparty) -> Vec<(u64, i64)>` reads the `trade_offer` rows naming
`counterparty` on the COUNTERPARTY column through its btree index, keeps the `is_active()` ones and projects
`(trade_id, created_at_ms)`; `trading::decline_offers(ctx, &[u64])` disarms each offer's TTL schedule row and
deletes the offer, in the `erase_trade_offers` order. Both live in `trading.rs` because only that module writes
`trade_offer` (D0 write isolation) and `disarm_trade_reaper` is private to it; neither names any account-state
seam, so the m22-s5 bypass bans and rb-47's seam-containment scan stay satisfied. A closure-taking shell
(`&dyn Fn(&[..]) -> Vec<u64>`) was the first draft and was cut at plan review: the read/plan/write split is the
crate's existing idiom (`plan_deletion_rearms` / `ensure_deletion_reapers_armed`, `erase_trade_offers`,
`cancel_trades_on_disconnect`), needs no higher-order parameter in production code, and pins as two ordinary
whole-body freezes plus one ordinary call-site statement.

### D3 — Call site: one depth-0 statement between the AUTH-38 gate and the status write

```rust
    crate::trading::decline_offers(
        ctx,
        &plan_declines_at_cancel(&account, &crate::trading::open_offers_addressed_to(ctx, me)),
    );
```

BEHIND `needs_cancel_write` (an already-`Active` caller sweeps nothing — the rb-24 disarm argument) and BEFORE
`.update(cancelled_deletion(account))`, because `account` is moved into that constructor and the planner must
judge the PRE-cancel row: judged after the flip, every offer reads as admitted and the sweep is a no-op. The
compiler enforces the order (a borrow of a moved value); the source pins enforce it textually. The final body
order is JWT → lookup → PRV1-4 terminal guard → AUTH-38 gate → sweep → status write → reaper disarm. Every
pre-existing clause on this body (`auth38_cancel_account_deletion_shape`, `rb24_cancel_disarms_the_reaper`, the
m22-s3 terminal-guard clauses) is unchanged and still green: the statement introduces no brace, no `return`, no
rebinding of `me` or `account`, no arm token.

### D4 — Scope: counterparty column only, active offers only

`propose_trade` is blanket-gated for the caller (ADR-0227, `trading.rs:252`), so a deletion-gated D can never
ORIGINATE a post-request offer; every initiator-side offer of D's predates the request and is exactly the
in-flight commitment PRV1-10 protects — sweeping that column would be a real PRV1-10 break. The asymmetry against
`erase_trade_offers` (both columns) is deliberate: that sweep runs after erasure, where nothing may survive naming
the row. `is_active()` is the one shared liveness spelling; today `TradeStatus` has exactly two variants and both
are active, so the filter is forward-defensive against a future terminal variant rather than live protection, and
a test states so. A `ConfirmedByCounterparty` offer naming D as counterparty necessarily predates the request (the
rb-47 gate refused every other accept) and is correctly not swept.

### D5 — Why this is inside the spec, and the escalation

PRV1-3 lists what a cancel SHALL do — status to `Active`, clear the stamp, preserve the claim pair, delete the
reaper row — and every item behaves exactly as specified; the sweep is an addition to that list, not a
contradiction of it. PRV1-10 forbids force-terminating an ALREADY-LIVE commitment at REQUEST time; the sweep runs
at CANCEL time, on offers created after the request — offers that were never live for D and that D could never
complete. §4.7's "the gate rejects NEW commitments only; it does not retroactively void in-flight state" describes
the gate, and the swept set is precisely the set the gate already refuses. D gains no capability: `cancel_trade`
(`trading.rs:765-783`) lets EITHER party delete an active offer and is ungated for a mid-grace caller (ADR-0227
D5), so D could already destroy C's offer by hand at any instant; the sweep automates a decline D already owns.
No asset moves — escrow is guard-in-place (ADR-0106 D8) and a delete is byte-identical in effect to
`respond_trade(accepted = false)`. The offer would die by `TRADE_OFFER_TTL_MS` (one hour) regardless. Because the
residual's history had asked for an operator scoping call three times, the decision was raised to the operator as
a NON-blocking decision issue with this ADR's default (ship the bounded sweep; the alternative is a wontfix
matching R-rb-47-PREDATING), and the PR asks the supervisor to hold the merge if the operator objects. The harness
spec's PRV1-3 gains no sibling clause from a project PR; that gap is registered as R-rb-83-SPECPRV13.

### D6 — Anti-decisions

No retained stamp and no re-request binding (D-context above). No anchor column. No gate on `confirm_trade`
(ADR-0237 D5, and it would need a counterparty-keyed read — the ADR-0227 D4 oracle). No refusal of the cancel
while such offers exist (that is the trap state AUTH-38 exists to prevent, and it would hand C control over D's
cancel). No sweep at re-request time in `delete_account` (PRV1-10, and the swap has already executed by then in
the EARS ordering). No closure-taking shell. No second spelling of the stamp comparison outside `accounts.rs`, no
`unwrap_or` on the stamp, no shared account-row helper (it would re-cut the byte-frozen `is_pending_deletion`).

### D7 — Enforcement: execution where the host allows it, source pins where it does not

The rb-41 native host aborts the process on any write syscall, so `cancel_account_deletion` cannot be executed to
its write. Executed: the planner's truth table (five account shapes, offsets around a non-zero stamp including
negative stamps and both `i64` extremes, input order, the laundering pair — the same offers judged against the
pre-cancel row and against `cancelled_deletion(row)` read non-empty then empty), the read function under the
native host (a stranger's offer, an initiator-side offer and two counterparty-side offers seeded; exactly the two
counterparty pairs returned; the counterparty btree index requested), and `decline_offers` with an empty slice.
Pinned: the call-site statement exactly once at depth 0, after the gate and before the status write, with no
`return` token between, no rebinding of `account`, no clock read in the body, and the whole squashed prefix above
it frozen byte for byte (rb-79 shape); whole-body equality on all three new functions (ADR-0237 D6's lesson);
declaration counts; the `#[cfg` / `#![cfg` file counts; the seam bans on `trading.rs`; the disarm-before-delete
order inside `decline_offers`; and a fifth site in EA-REAPER-02. **Substrate finding, measured by the plan
red-team:** `accounts_tests.rs`'s `stripped_for_scan` blanks strings BEFORE comments, so a bare double quote inside
a `//` comment opens a phantom string that hides a real statement — including a same-name rebinding of `account`
to the post-cancel row placed above the sweep — from every positional clause in that file. The rb-83 clauses
therefore read a comments-first view (`strip_comments_keep_strings` → `strip_rust_strings` → `squash_ws`) and carry
a polarity precondition (the cancel body must read identically under both pipelines). The artifact red-team then
measured the sibling shape neither pipeline can see — a hidden rebinding framed by two quote CHAR literals (`'"'`),
which blanks identically under both views and was caught only by the byte-exact prefix freeze — so the headline test
also bans every quote-bearing char-literal spelling from the raw `accounts.rs` (zero at HEAD). The pre-existing
clauses in that file are not re-cut here; both classes are registered as R-rb-83-SCANORDER.

## Considered alternatives

- **Retain the request stamp across a cancel; a re-request within the original window re-uses it** — the
  residual's own named mechanism. Contradicts AUTH-29 and PRV1-3 verbatim, ADR-0195 D3, the load-bearing
  `is_deletion_due(None, _)` contract, and misreports `Active` rows through `my_account` and the export bundle.
  Rejected.
- **An additive `#[default(None)]` anchor column on `account`** (the `terminal_at_ms` precedent) — legal under
  ADR-0006 but a schema slice: bindings, baseline, six test files, a privacy-surface review. Rejected here;
  available to a future slice if the operator wants the deadline itself bound.
- **Gate `confirm_trade`** — ADR-0237 D5 anti-decision; initiator-side; needs a counterparty oracle. Rejected.
- **Refuse `cancel_account_deletion` while a refused offer exists** — a trap state controlled by a third party.
  Rejected.
- **Sweep in `delete_account` instead** — PRV1-10 (request time) and too late for the EARS ordering. Rejected.
- **A closure-taking shell in `trading.rs`** — equally seam-safe but a first-of-its-kind higher-order production
  parameter for one call site. Rejected at plan review in favour of the two plain functions.
- **`Pending`-only or both-column sweeps** — the former silently narrows on a future variant; the latter breaks
  PRV1-10 on D's own predating offers. Rejected.

## Consequences and residuals

- **Closed:** R-rb-47-CANCELLAUNDER — a post-request offer can no longer be accepted after a cancel, nor after a
  cancel/re-request cycle, however many confederates or cycles are involved.
- **By design, unchanged:** Flow A (R-rb-47-PREDATING, wontfix) — an offer created BEFORE the request stays
  completable across a cancel; an offer created AFTER the cancel is plain Active trading; a cancel/re-request cycle
  restarts the grace window (binding it to the original deadline is the AUTH-29/PRV1-3 spec change this slice
  declines to make, and after the sweep it buys nothing against this attack).
- **Residual R-rb-83-CHALLENGELAUNDER (backlog, MED).** `pvp::accept_challenge` is BLANKET-gated with no stamp-aware
  sibling, so the identical cancel-then-accept-while-momentarily-Active shape exists for `battle_challenge`;
  bounded by the two-minute challenge TTL; `pvp.rs` is outside this slice's touches.
- **Residual R-rb-83-CANCELORACLE (backlog, LOW).** The sweep deletes, in one transaction, every refused offer
  naming the caller — a confederate who planted probe offers at known stamps learns, from which vanish together,
  both that D cancelled and roughly where D's request stamp fell: a sharper timing channel than a per-offer
  decline or TTL death. Not closable without abandoning the cancel-time design; recorded for a privacy audit.
- **Residual R-rb-83-SPECPRV13 (backlog, LOW, supervisor-owned).** The harness spec's PRV1-3 needs a sibling clause
  naming the sweep so the spec describes shipped behaviour.
- **Residual R-rb-83-SCANORDER (backlog, MED).** Every pre-existing positional pin built on
  `accounts_tests.rs::stripped_for_scan` (the rb-24 arm/disarm pins, the m22-s3 guard pins) is blind to a bare
  double quote inside a comment in the scanned body, and every stripper in the crate's test modules is blind to a
  quote-bearing char literal; the repo-wide fix is to swap that pipeline to comments-first (the `trading_tests.rs`
  order) and give the string strippers a char-literal branch, or to add the per-body polarity precondition and the
  raw char-literal ban as rb-83 does.
- The cost to a confederate — an offer destroyed without consent, escrow released, re-proposal needed once D is
  Active — is bounded and smaller than the TTL death the same offer already faced.
- New code comments in `accounts.rs` and `trading.rs` contain no double-quote character.
- Disclosed: the ADR number 0252 was taken instead of the supervisor-reserved 0251, which rb-81 had already used.

## Confirmation

`just ci` runs, inside `cargo nextest run -p monster-realm-module`, the four `rb83_` tests —
`rb83_cancel_declines_refused_offers_before_the_status_write` and `rb83_plan_declines_at_cancel_truth_table` in
`server-module/src/accounts_tests.rs`; `rb83_open_offers_addressed_to_reads_only_the_counterparty_column` and
`rb83_new_seams_are_declared_once_and_frozen` in `server-module/src/trading_tests.rs` — plus the fifth site in
`ea_reaper_02_disarm_called_at_all_offer_deletion_sites` and the D4 liveness note on
`trade_status_is_active_covers_both_variants` (a fifth `rb83_` test restating that fact was cut at tests review as a
duplicate).
The proof-of-teeth register (`memory/projects/gates/rb-83.mutants.py`, record in `rb-83.red-before.md`, harness
repo) is cited from ledger gate X7, never from this ADR body.
