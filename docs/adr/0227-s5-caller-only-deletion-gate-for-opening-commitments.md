# 0227 — S5 gameplay deletion gate: caller-only `guards::require_not_deleting` on the three commitment-opening reducers, delegating transitively to `should_reject_for_deletion`

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s5
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz
**Extends:** ADR-0225 (no reciprocal back-link edit — `docs/adr/0225-*` is outside this slice's declared touches)
**Decision:** S5 gates the three commitment-OPENING reducers with `guards::require_not_deleting`, a caller-only ctx wrapper delegating via `is_pending_deletion` to `should_reject_for_deletion`; already-open reducers stay ungated (PRV1-10).

---

## Context and problem statement

M22 §4.7 requires that an account in `PendingDeletion` (or carrying the terminal marker) can open
no NEW trade, battle, or challenge commitment, while §4.7's own "don't boot a live game, just stop
new ones" and PRV1-10 forbid force-terminating commitments that are already live. ADR-0225 §Decision 2
fixed the predicate's home (`accounts::should_reject_for_deletion(&Account)`, accounts.rs) and
mandated that S5's `guards.rs` wrapper DELEGATE rather than re-derive the disjunction. This slice
wires that predicate into the commitment-opening reducers of `trading.rs` and `pvp.rs` — and only
those — with the enforcement tests shipped as ordinary Rust `#[test]`s (ADR-0224).

## Decision

### D1 — Delegate target: `crate::accounts::is_pending_deletion(ctx, ctx.sender())`, both hops pinned

The wrapper does NOT do its own `ctx.db.account()...find()` lookup. `accounts::is_pending_deletion`
(the ctx-bound D7 SSOT) already owns the row-lookup shape (`find(identity).is_some_and(|a|
should_reject_for_deletion(&a))`, false on a missing row — an identity with no `account` row has no
deletion state), and duplicating that lookup in `guards.rs` would be a second spelling of
"does this identity refuse gameplay" — the exact class ADR-0189 D2 banned when it pinned
`ctx.db.account(` out of `pvp.rs`.

**Relation to ADR-0225 §Decision 2 (deliberate interpretation).** Two merged texts read as if
`guards.rs` must call `should_reject_for_deletion` DIRECTLY (ADR-0225:76-77 "S5's `guards.rs`
ctx-bound wrapper must DELEGATE to it"; accounts_tests.rs ~:7397 "S5 guards.rs must call it rather
than re-derive it"), while the merged doc on `is_pending_deletion` (accounts.rs ~:331) says the
opposite ("D7 SSOT — reused by … M22 gameplay-gate call sites, never re-derived"). The
contradiction is pre-existing in S3's own comments. This ADR resolves it: ADR-0225's operative
prohibition is *never re-derive the disjunction*, and delegation is satisfied **transitively** —
`require_not_deleting` → `is_pending_deletion` → `should_reject_for_deletion` — with ADR-0189 D2
as the tie-breaker (reuse the ctx-bound wrapper; never a second account-lookup shape). Two gating
tests are **jointly** the proof of ADR-0225 compliance and neither is sufficient alone: the
delegation pin (`guards.rs` wrapper body calls `crate::accounts::is_pending_deletion(ctx,
ctx.sender())` exactly once, and `guards.rs` contains no `PendingDeletion` / `terminal_at_ms` /
`AccountStatus` / `account_has_terminal_marker` / `ctx.db.account(` spelling) and the far-hop pin
(`is_pending_deletion`'s body reaches `should_reject_for_deletion(` exactly once). Breaking either
hop is a gating-test red.

### D2 — Wrapper shape: no identity parameter, one static reason, `log_reject` only

`pub(crate) fn require_not_deleting(ctx: &ReducerContext, reducer: &str) -> Result<(), String>`
reads `ctx.sender()` internally (the `authorize_move` precedent). Omitting the identity parameter
makes caller-only gating structural — a counterparty-gating call site is unwritable without
changing the signature (see D4). The verdict mapping is the pure
`deletion_gate(rejected: bool) -> Result<(), &'static str>` (the `ranked_account_gate` idiom,
ADR-0189 D5 rationale: `ReducerContext` is not constructible in tests, so the polarity gets a
behavioral truth-table kill instead of a text pin). The body's leading expression is the FUSED
call `deletion_gate(crate::accounts::is_pending_deletion(ctx, ctx.sender()))` with the reject
side handled in `.map_err` — fused on purpose: the plan-phase red team measured that decomposed
pins (call present + log present + pure fn correct) admit an inverted-polarity or hollowed
wrapper with every pin green, while pinning the fused expression as the body's head closes
negation, rebinding, dead-branching and control-flow diversion in one assertion. Call sites are
single statements, FULLY QUALIFIED with `?`-propagation — `crate::guards::require_not_deleting(
ctx, "<reducer>")?;` — also on purpose: the qualified path is unshadowable by an import swap
(the `crate::accounts::is_account_holder` precedent in these same reducers) and the pinned `)?;`
suffix kills a `let _ =` / `.ok()` result-discard. One static, PII-free reason,
`REJECT_DELETION_GATED` — a per-state pending-vs-terminal message would require `guards.rs` to
distinguish the two states, which is exactly the re-derivation D1 forbids (a two-message gate
cannot delegate to a single boolean); the AUTH-13 message split stays with the slice that makes
terminal rows reachable (ADR-0225 consequence). Reject path calls `log_reject(reducer, …)` — never
a bare `log::` macro (`.log-baseline` pins guards.rs's bare-macro counts). Note for S8: the client
deletion UX will likely want a `claimModel.ts`-style entry matching this reason string; no client
change is forced now (`client/**` is S8's).

### D3 — Gated set and placement: exactly {`propose_trade`, `challenge_pvp`, `accept_challenge`}

The gate slots in immediately after the caller's own standing is established, before any other
party is touched and before every write:

- `propose_trade` — **Guard 1a**, after the caller-joined check (guard 1), before the counterparty
  lookup. NOT above guard 0: ADR-0166 D3's "bound both sides before ANY DB read" is load-bearing
  and the gate is a DB read (trading_tests pins `let me = ctx.sender();` immediately followed by
  `check_trade_side_size(`).
- `challenge_pvp` — **Guard 1a**, after guard 1 (joined), before the target lookup. Deliberately
  EARLIER than guard 3a's late placement: ADR-0189 D8 bounds when a THIRD PARTY's account existence
  may be disclosed; a caller-only self-property discloses nothing, so the D8 bound does not
  transfer. Do not "fix" the asymmetry.
- `accept_challenge` — **Guard 2a**, after guard 2 (caller is the target — authorization before
  state, the ADR-0117 ordering), before guard 3/3a and every write. Accepting is gated because it
  OPENS the battle commitment (`start_pvp_battle`, whose only caller this is): the pending
  challenge row it consumes is not force-terminated — it stays pending until TTL/decline/cancel,
  all of which remain available.

### D4 — Caller-only; counterparty gating considered and REJECTED

Gating on the counterparty's (or challenger's) deletion state would turn the reject into a
deletion-status oracle about another player — inside the privacy milestone, the same hazard class
ADR-0189 D8 bounded. It is also unnecessary for correctness: §4.4 step 1 force-resolves the
deleting identity's live trades/challenges/battles at actual cascade time, and `trade_offer` /
`battle_challenge` are ERASE-policy rows. If counterparty gating is ever wanted, the correct shape
is an indistinguishable generic "target unavailable", never a deletion-specific reason.

### D5 — Anti-decision (load-bearing): `submit_pvp_action` is NOT gated

Spec §4.7 lists "PvP action submission" among the gate targets. Gating it would make a
pending-deletion player unable to act in a live battle; `pvp_deadline_reaper` would then forfeit
them on timeout — de-facto force-termination at request time, contradicting PRV1-10 and §4.7's own
"don't boot a live game, just stop new ones". The crate-wide PRV1-7 slice must NOT follow §4.7's
reducer list blindly; in-flight-interaction reducers (`respond_trade`, `confirm_trade`,
`cancel_trade`, `decline_challenge`, `cancel_challenge`, `submit_pvp_action`, the reapers) stay
ungated by design. The negative census is scoped to `#[spacetimedb::reducer]` functions in the two
touched files; the disconnect helpers (`forfeit_on_disconnect`, `cancel_*_on_disconnect`) are
plain functions driven by `lib.rs`'s `on_disconnect` and are excluded by construction.

### D6 — Enforcement vehicle: structure tests, justified once

Reducer bodies have no runtime harness, so the wiring facts (call present, before the first write,
in exactly the three bodies) are pinned by targeted `include_str!` source-structure assertions in
the sibling `*_tests.rs` files, per ADR-0225 §Decision 5 / ADR-0224; the pure surfaces
(`deletion_gate`, the reason constant, the predicate truth table already shipped in S3) are
ordinary behavioral tests. No new eval scripts.

## Considered alternatives

- **Direct `ctx.db.account()` lookup + `should_reject_for_deletion` call in `guards.rs`** —
  satisfies ADR-0225's letter in one hop, but duplicates the account-lookup shape the crate
  deliberately keeps in one place (ADR-0189 D2) and adds a second `Option`-handling spelling of
  the same question. Rejected; see D1's transitive-delegation resolution.
- **Gate the counterparty too** — rejected (D4: third-party deletion-status oracle; cascade
  already force-resolves).
- **Gate every §4.7-named reducer now (incl. accept/respond/submit/shop)** — rejected: PRV1-7's
  crate-wide mechanism is explicitly deferred to a supervisor decision (ADR-0225 consequences),
  `respond_trade`/`confirm_trade`/`submit_pvp_action` act on already-open interactions (PRV1-10),
  and `battle.rs` / `economy.rs` are outside this slice's declared touches.

## Consequences and residuals

- **PRV1-7 crate-wide enforcement** ([DEL-06] equivalent) remains open; its mechanism needs a
  supervisor decision under ADR-0224 (no new eval scanners). The census-equality tests here are a
  local tripwire, not the crate-wide gate: a NEW reducer added to `trading.rs`/`pvp.rs` reds the
  census and must be classified deliberately (gate it or extend the already-open list).
- **Still-ungated §4.7 targets, deferred with the file they live in:** PvE `battle::start_battle`
  (battle.rs — opens a wild-battle commitment) and shop `economy::buy`/`sell` (§4.7 "DECIDED IN").
  Both are outside S5's declared touches; deferred to the PRV1-7 crate-wide slice via the ledger.
- `accounts::is_pending_deletion`'s name now under-describes its meaning (terminal-aware,
  commitment-gating); a rename is deferred — `accounts.rs` is outside this slice's touches.
- A pending-deletion player retains full use of already-open interactions: they can respond to /
  confirm / cancel trades, decline or cancel challenges, and act in live battles. Only NEW
  commitments are refused.
- Proof-of-teeth: a 15-mutant register (drop a call site; reorder past a write — both pvp
  shapes; re-derive in guards; invert polarity at the fused argument AND inside `deletion_gate`;
  gate an already-open reducer; misattribute the log tag; break the far hop in accounts;
  dead-branch a call site; decoy-comment the needle; hollow the wrapper; discard the Result at a
  call site; append a recovery combinator; short-circuit the predicate) is executed one mutant at
  a time with the designated failing test recorded per row;
  the register and its run evidence live in the slice acceptance ledger
  (`memory/projects/gates/m22-s5.gates.md`, gate X6) rather than this ADR body, so the digest
  gate never staleness-flags evidence lines.
- **Artifact red-team hardening (post-impl pass, folded in before merge).** Two bypasses were
  measured CI-green against the as-implemented pins and killed by whole-body EXACT-EQUALITY
  assertions: (M13) a trailing `.or(Ok(()))` recovery combinator appended after the wrapper's
  reject-mapping closure — the prefix pin, fused count, tag pins and census all stayed green while
  every reject was converted back into success; (M14) a leading short-circuit `return false` in
  `accounts::is_pending_deletion` on a condition rustc cannot constant-fold — both containment
  clauses of the far-hop pin survived textually while the predicate went dead for every caller.
  The wrapper body and the predicate body are now pinned byte-for-byte in the squashed view
  (guards_tests.rs); the census extractor additionally bans `cfg_attr(` and renamed
  reducer-attribute imports (camouflage that would make a reducer invisible to the census rather
  than a loud parse error), and the order pin's write-verb set includes the four write-performing
  cross-module helpers (`grant_item`/`consume_one`/`grant_currency`/`spend_currency`) a gated
  body could reach without a local write verb.
- **Confederate role-swap residual (reducer-security-auditor finding, DEFERred as ledger X13 →
  backlog).** A deleting identity D can still consummate a NEW trade commitment mid-grace:
  confederate C proposes a trade TO D after D's deletion request (the caller-only gate passes for
  C by design — D4), D calls the ungated `respond_trade(accepted = true)`, C confirms. Closing it
  needs an offers-created-after-request timestamp comparison (PRV1-10 requires offers predating
  the request to stay completable), which requires account-state access that the S5 bypass bans
  deliberately keep out of `trading.rs` — i.e. a new accounts/guards seam plus census/tests
  rework, out of this slice by its own "reducers acting on already-open interactions stay
  untouched" rule. Auditor rider: D4's compensating control (the §4.4 step-1 cascade
  force-resolve) is S3b, unshipped — until S3b lands nothing cleans up commitments dangling
  against a deleting account, so this residual's priority rises with issuer activation (exposure
  today is nil: `ALLOWED_ISSUERS` is the fail-closed `.invalid` placeholder).
