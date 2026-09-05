# ADR-0237 — `respond_trade` refuses an accepting response to an offer created at or after the caller's own deletion request; predating offers stay completable

**Status:** Accepted
**Date:** 2026-09-05
**Slice:** rb-47 (residual R-m22-s5-X13, `M-residual-backlog.spec.md#rb-47`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0227 (the S5 caller-only gate; reciprocal `Extended-by:` in its header, and its confederate role-swap residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, economy-quests
**Decision:** rb-47 gates the accept path of `respond_trade` on the offer's stamp: a deletion-gated caller cannot accept an offer created at or after their own deletion request; predating offers stay completable (PRV1-10).

---

## Context and problem statement

M22 §4.7 forbids an account in `PendingDeletion` from opening NEW trade, battle or challenge commitments,
while PRV1-10 forbids force-terminating commitments that are already live. ADR-0227 therefore gated the three
commitment-OPENING reducers with the caller-only `guards::require_not_deleting` and deliberately left the
in-flight reducers — `respond_trade`, `confirm_trade`, `cancel_trade` — ungated (ADR-0227 D5). Its
reducer-security-auditor found the shape that decision admits: D requests deletion; a confederate C proposes a
trade TO D afterwards (the caller-only gate passes for C by design — ADR-0227 D4 rejected counterparty gating
as a deletion-status oracle); D calls the ungated `respond_trade(accepted = true)`; C confirms. A NEW commitment
is consummated mid-grace. ADR-0227 deferred it as residual X13 because the fix needs an offer-vs-request
timestamp comparison, and the S5 bypass bans deliberately keep every account-state read out of `trading.rs`.

The seeded criterion (immutable): WHEN a trade offer NAMING a deletion-gated identity as counterparty was
created AFTER that identity's deletion request THE SYSTEM SHALL reject that identity's accepting response before
any write; offers predating the request stay completable. A blanket `require_not_deleting` on `respond_trade`
was ruled out twice over: it would refuse a legitimately predating accept (PRV1-10), and
`guards_tests.rs` pins that `respond_trade` never mentions the blanket wrapper's bare name.

## Decision

### D1 — Pure predicate: `accounts::opened_commitment_is_refused(&Account, opened_at_ms) -> bool`

`account_has_terminal_marker(account) || (should_reject_for_deletion(account) && match
account.deletion_requested_at_ms { None => true, Some(requested) => opened_at_ms >= requested })`.

- **Terminal marker ⇒ refuse at every stamp**, tested FIRST and OUTSIDE the stamp comparison. Unreachable in
  production by construction — the cascade's `erase_trade_offers` sweeps both offer columns in the same
  transaction that stamps the marker — and kept as the stated fail-closed contract ("an already-erased account
  must never be allowed new commitments").
- **Mid-grace ⇒ refuse iff the offer was created at or after the request.** The mid-grace arm DELEGATES to
  `should_reject_for_deletion` (ADR-0225: never re-derive; a third disjunct added there widens this consumer
  with it). This is the opposite of `reaper_should_run_cascade`, which is defined directly so that widening the
  gate can never widen what the reaper erases — this consumer WANTS to widen with the gate; `reaper_rearm_at_ms`
  and `plan_deletion_rearms` compose their own halves the same way.
- **Boundary `>=`, and the tension with the EARS word "AFTER", recorded.** Both stamps are `now_ms(ctx)`, the
  ms-floored transaction clock, so an offer proposed in the same millisecond as the request is reachable across
  two transactions, and the attack this closes is "request deletion, then have the confederate propose
  immediately". An offer created IN the request millisecond does not PREDATE it; the house convention is
  trigger-side inclusive (`is_deletion_due`, `claim_is_expired`). The cost is a deliberate, fail-closed false
  reject in a sub-millisecond window for an offer that genuinely predates the request by transaction order —
  D can still decline, and the offer expires by TTL.
- **Missing stamp while gated ⇒ refuse.** The only reachable shape is the illegal stamp-less `PendingDeletion`
  row that `account_state_is_legal` debug-asserts away. Spelled as an explicit `match` arm on purpose: every
  `unwrap_or` default hides the decision inside a value. `unwrap_or(i64::MIN)` is behaviourally identical and is
  NOT a defect; `unwrap_or(0)` admits negative stamps, which is why the truth table probes negative offsets with
  a non-zero request stamp.
- **Not gated ⇒ admit at every stamp** (no divergence from the blanket gate's admit set).

### D2 — Context-bound predicate: `accounts::refuses_commitment_opened_at(ctx, identity, opened_at_ms) -> bool`

The account row of `identity`, `.is_some_and(|a| opened_commitment_is_refused(&a, opened_at_ms))`. Missing row ⇒
admit (a guest has no deletion state), exactly as `is_pending_deletion`. The duplicate lookup shape is deliberate:
a shared row helper would force re-cutting the byte-frozen `is_pending_deletion` pin. **It is a second
identity-taking oracle primitive**, so ADR-0227 D4 is restated for it: the ONLY sanctioned consumer is the guards
wrapper of D3, which reads `ctx.sender()` internally and therefore cannot be pointed at a third party. That
containment is mechanical (D6), not a convention.

### D3 — Guards wrapper: `guards::require_commitment_predates_deletion(ctx, reducer, opened_at_ms) -> Result<(), String>`

One fused expression mirroring `require_not_deleting`:
`deletion_gate(crate::accounts::refuses_commitment_opened_at(ctx, ctx.sender(), opened_at_ms)).map_err(..)` with
`log_reject(reducer, ctx.sender(), e)` on the refuse path. Caller-only BY SIGNATURE (no identity parameter).
Reuses `deletion_gate` and the single static reason `REJECT_DELETION_GATED`: ADR-0227 D2 fixes ONE reason per
gated shape so `guards.rs` never learns the account-state split; the existing polarity, PII and distinctness
pins already cover the constant; the client maps no server reject string today and the client tree is outside
this slice. The semantic drift is recorded for S8's client UX: this is a refused ACCEPT, not a refused opening,
even though the text reads "new trades … are unavailable". No new bare `log::` (the `.log-baseline` row for
`guards.rs` is unchanged); none of `guards.rs`'s five banned account-state spellings appears.

### D4 — Call site: one depth-0 statement in `respond_trade`

`crate::guards::require_commitment_predates_deletion(ctx, "respond_trade", offer.created_at_ms)?;`

- AFTER `authorize_respond` (ADR-0117 role-first: a non-party learns only that they are not a party). This
  ordering is also what makes a CALLER-keyed gate correct here: `authorize_respond` has already proved the sender
  IS this offer's counterparty. The gate's correctness is therefore ORDER-DEPENDENT on the authorization staying
  above it — held by the prefix-equality and ordering clauses of the call-site pin.
- AFTER the decline block. Declines unwind a commitment and release escrow; gating them would trap the
  counterparty's assets in an offer nobody can cancel — the exact trap-state defect the already-open census in
  `guards_tests.rs` names. Placement, not a condition, is what keeps declines open (an `if accepted { gate }`
  would break the depth-0 reachability pin).
- BEFORE the sole status update. `offer.created_at_ms` is read inline, before the row is moved.
- **The ARGUMENT is the central tooth.** Passing `0` or `i64::MIN` makes the gate never fire; passing
  `now_ms(ctx)` makes it refuse every predating offer (a PRV1-10 break). Neither is observable by execution
  (the native host aborts before the admitted direction of the reducer can be seen), so the source pin needles
  the WHOLE statement including `offer.created_at_ms`.

### D5 — Anti-decisions (restated so the successor does not re-open them)

No gate on declines. No gate on `confirm_trade`: it is initiator-side, and a deleting identity cannot originate a
post-request offer because `propose_trade` is gated for it; `trading.rs` has exactly one writer of
`ConfirmedByCounterparty`, and the disconnect and cascade resolvers only cancel. No counterparty gating (ADR-0227
D4). No per-state or format-hole reason. No blanket gate. No back-derivation of the request stamp from the
deletion-reaper schedule row (fail-open when no row is armed). No `unwrap_or` on the stamp. The doctrine
asymmetry is recorded, not "fixed": `accept_challenge` is BLANKET-gated (a pre-request challenge cannot be
accepted mid-grace) while the trade accept is stamp-conditioned — the challenge rule is the stricter one, declining
stays open in both, so neither is a trap state.

### D6 — Enforcement vehicle: execution first, then source pins for what execution cannot see

Executed under the rb-41 native host: the pure truth table (five account shapes × offsets around a NON-ZERO
request stamp including negative offsets and both `i64` extremes; fixtures carry a non-empty issuer and non-zero
creation stamps so a field-keyed short-circuit is observable); the ctx predicate and the wrapper through five
caller states × three offsets with a stranger's mid-grace row present throughout and two calls that pass the
STRANGER's identity (the only place the identity parameter is observable); and the SHIPPED `respond_trade` over
a `u64`-keyed `trade_offer` fixture — the key-generic `Fixture::table_keyed` added to `native_host_tests.rs` —
in the REFUSED direction only, with three controls (wrong status, wrong role, unknown id) proving the fixture
resolves rows and the gate sits below the authorization. Every write syscall aborts the process, so the admitted
direction of the reducer is never executed anywhere; it is covered one call below by the wrapper test and
textually by the argument pin.

Source pins own the rest, and — the lesson m22-s5 recorded and rb-47 first dropped, then measured again — they
are WHOLE-BODY EQUALITY pins on all three new seams, not containment: the artifact red-team executed a leading
clock-keyed early return in the ctx predicate (`now_ms(ctx) > 0` is false under the native host and true in
production), a trailing `.or_else` recovery combinator on the wrapper, a `cfg!(test) &&` prefix and an
`auth_issuer`-keyed early return in the pure predicate — all CI-green against containment and `starts_with`
clauses, all red under equality. Also pinned: declaration counts for every new fn AND for `deletion_gate` and
`should_reject_for_deletion` (a `#[cfg(test)]`/`#[cfg(not(test))]` twin pair ships an ungated wasm with every
behavioural test green); `deletion_gate`'s own body (it had no source pin; `if rejected && cfg!(test)` switched
off every deletion gate in the product); whole-file counts of `#[cfg` (exactly one, the test-module line) AND
`#![cfg` (zero — the inner-attribute spelling is invisible to every `#[cfg` census) in `accounts.rs`,
`guards.rs` and `trading.rs`; the call-site statement boundary; PREFIX EQUALITY above the gate, because rb-46's
return-census clause is unsatisfiable in `respond_trade` (its prefix legitimately contains a not-found return and
the decline's success return) — the sole defence against the above-the-gate class, and it retires the
`macro_rules!` residual ADR-0236 disclosed for this site; the strings-intact reducer tag; the propose-time stamp
provenance (`created_at_ms: now_ms(ctx),` exactly once in `propose_trade`, the only clock read there — the gate's
only data input is server-set and unmodified; a back-dated or client-supplied stamp is a red); a CLOSED roster of
the reducers declared in `trading.rs` (a byte-identical ungated twin reducer passed every existing census and
the trade-reducer-security eval, whose name list is hard-coded); and crate-wide seam containment: every module
`lib.rs` declares — minus `accounts`, `guards`, `schema` and the test modules — is read at test time and must
reach neither half of the new seam, with `guards.rs` required to consume the ctx predicate exactly once.

### D7 — Names are load-bearing and prefix-free

`opened_commitment_is_refused`, `refuses_commitment_opened_at` and `require_commitment_predates_deletion` contain
none of the pinned markers (`require_not_deleting`, `fnrequire_not_deleting(`, `should_reject_for_deletion(`,
`crate::accounts::is_pending_deletion(`) and none is a substring of another. A tempting
`require_not_deleting_since` would red three m22-s5 pins; a prefixed `account_refuses_commitment_opened_at` would
silently double every count pin.

## Considered alternatives

- **Call the new accounts predicate directly from `trading.rs`, skipping `guards.rs`** — passes the S5 bans
  textually but is the exact class they exist for (a reducer consulting the predicate itself is gated by a rule
  no fence constrains), loses `log_reject` and the pinned `deletion_gate` polarity. Rejected.
- **A shared `account_row()` helper** in `accounts.rs` — would re-cut the byte-frozen `is_pending_deletion` pin.
  Rejected; the duplicate lookup shape is deliberate.
- **A second reason string** — a per-gate message forces `guards.rs` toward the state split it is banned from
  knowing, and a new constant would need its own PII/distinctness pins. Rejected in favour of the recorded drift.
- **`>` (strict) boundary** — hands the confederate a deterministic same-millisecond window. Rejected.
- **`unwrap_or` / `is_none_or` spellings of the missing-stamp arm** — the explicit arm is the readable
  fail-closed spelling and the `unwrap_or` family is banned in the body. Rejected.
- **Counterparty gating in `propose_trade`** — ADR-0227 D4's oracle hazard, and it cannot retro-close offers.
- **Back-deriving the request stamp from the deletion-reaper schedule row** — fail-open, and a second spelling of
  the stamp. Rejected.
- **Gating `confirm_trade` as well** — refuses completion of a predating offer (PRV1-10). Rejected.
- **Source pins only, or execution only** — rejected for the reasons in D6; each owns what the other cannot see.

## Consequences and residuals

- **Residual R-rb-47-PREDATING (backlog; spec-change class, not a defect).** Flow A: C proposes BEFORE D's
  request, D requests, D accepts, C confirms — a mid-grace swap admitted BY THE IMMUTABLE EARS and PRV1-10. It
  grants no capability D lacked one millisecond earlier and is bounded by `TRADE_OFFER_TTL_MS` (one hour; the
  reaper sweeps `ConfirmedByCounterparty` offers too).
- **Residual R-rb-47-CANCELLAUNDER (backlog; spec-change class).** Flow B: D cancels the deletion (stamp
  cleared, status Active), accepts, C confirms, D requests again with a fresh stamp — equivalent to trading while
  Active; costs D a full new grace period.
- **Residual R-rb-47-ROSTER-PVP (backlog).** The closed reducer roster covers `trading.rs`; `pvp.rs` and the
  other reducer files keep the census shape that constrains only the names it lists, so an ungated twin reducer
  there is still invisible to tests (the PRV1-7 crate-wide slice's territory).
- This slice does NOT claim "the confederate role-swap is closed"; it closes offers CREATED at or after the
  request.
- The reducer proof is one-sided (write wall); the wrapper's `log_reject` REASON argument is compared nowhere
  behaviourally (only the returned `Err` is); the containment scan is the crate's first runtime file read in a
  test (`std::fs` under `CARGO_MANIFEST_DIR`) and excludes `schema.rs`, whose view bodies are code.
- Host-clock non-monotonicity is the only way to make the stamp comparison lie: both stamps are server-set from
  `ctx.timestamp`, no client input reaches either, and a backward clock step between propose and request could
  admit one offer. Recorded; no code change. `delete_account` forward-stamping the request (the gate would sleep
  for the offset) is caught only by an unrelated rb-24 test — this slice does not own that premise.
- Boundary smell, flagged: the pure age rule sits beside an `Account`-typed predicate in `server-module` while
  its sibling `is_deletion_due` lives in `game-core`; the stamp half is extractable later.
- **Disclosed hidden dependency.** The launch declared `trading.rs`, `trading_tests.rs` and the docs; the fix
  REQUIRED `accounts.rs` (+2 fns), `guards.rs` (+1 wrapper; `require_not_deleting` untouched and byte-pinned),
  `guards_tests.rs` (both canonical bypass arrays 5→7 and prose riders; zero assertion changes) and the additive
  `native_host_tests.rs` fixture (`Handle<'a, R, K = Identity>` keeps every pre-existing spelling). No sibling
  slice was in flight; all four are listed under `touches-delta:` in the PR.
- The pre-existing `propose_trade` gate pin gained the statement-boundary and `#[` / `cfg!(` escape test
  (`rb47_propose_trade_gate_has_no_attribute_or_cfg_escape`), closing R-rb-46-TRADINGCFG.
- The crate-wide caller set of `require_not_deleting` is unchanged at eight; `respond_trade` stays outside the
  blanket gate's census by design, with the census prose amended to say so.
- Proof-of-teeth: a 46-row mutant register (36 planned rows plus the ten artifact-red-team survivors, applied one
  at a time to a source copy by `memory/projects/gates/rb-47.mutants.py`) with the per-row designated-test record
  in `memory/projects/gates/rb-47.red-before.md`, cited from ledger gate X5, never in this ADR body.

## Confirmation

`just ci-fast monster-realm-module` (inside `just ci`) runs the ten `rb47_` tests in
`server-module/src/trading_tests.rs`: `rb47_opened_commitment_is_refused_truth_table`,
`rb47_accounts_seam_is_declared_once_and_delegates`, `rb47_ctx_predicate_answers_from_the_callers_row`,
`rb47_guards_wrapper_is_fused_and_unconditional`, `rb47_guards_wrapper_refuses_only_offers_created_after_the_request`,
`rb47_respond_trade_carries_the_offer_age_gate`, `rb47_propose_trade_gate_has_no_attribute_or_cfg_escape`,
`rb47_respond_trade_refuses_a_post_request_accept`, `rb47_no_reducer_module_reaches_the_stamp_seam_directly`,
`rb47_trading_reducer_roster_is_closed`, plus the widened bypass arrays in `server-module/src/guards_tests.rs`.
