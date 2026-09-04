# ADR-0235 — The claim-time export purge reports its count, and the claim reducer emits it as the terminal `mr_log` line

**Status:** Accepted
**Date:** 2026-09-04
**Slice:** rb-40 (residual R-rb-22-EO-9, `M-residual-backlog.spec.md#rb-40`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0220 (the claim-time purge helper), ADR-0180 D6 (`mr_log` as the sole new-emission point), ADR-0185 (an `mr_log` line at a domain call site), ADR-0224 (proof-of-teeth as ordinary tests)
**Subsystems:** security-authz, ci-gates
**Decision:** `purge_export_bundles` returns its deleted-chunk count; `complete_guest_claim` binds it and emits one `guest_claim_export_purge` line via `observability::mr_log` as its terminal statement, making the purge observable.

## Context and problem statement

rb-22 (ADR-0220) closed the pre-claim `export_bundle` orphan: when a guest claims an account, the retiring
guest identity's export chunks are deleted by `privacy::purge_export_bundles(ctx, guest)` inside
`complete_guest_claim`. rb-22 proved the purge STATICALLY (call-site pins, a frozen-body pin, a write census)
but left EO-9 open: nothing observable happens when the purge runs. An erasure step that leaves no trace cannot
be audited from the outside, and the residual's own deferred reason — "no writer of `export_bundle` exists" —
is now stale: m22-s4 (ADR-0226) shipped `request_data_export`, so pre-claim chunks are a live shape.

Two facts constrain where the signal can live. First, `privacy.rs` carries a gate-enforced scan-hygiene
contract (`rb22p_scan_hygiene`, `rb22p_no_bare_quote_in_privacy`): no `log::` token, no print macro, and no
double-quote byte beyond the one `#[path]` attribute — the module is deliberately inert to the dozen evals that
concatenate every `.rs` file and strip it naively, and its header states the consequence as doctrine: "the
reducer that calls a helper here owns any logging". Second, the OBS-2 ratchet (ADR-0180 D6, `.log-baseline`,
gates G1/G7) forbids any NEW bare `log::` call site anywhere in the crate; every new emission routes through
`observability::mr_log`. Neither `accounts.rs` nor `privacy.rs` has a baseline row, and `.log-baseline` is
outside this slice's `touches:`.

## Decision

1. **The helper reports what it did.** `purge_export_bundles(ctx, owner) -> usize` returns `ids.len()`, bound
   BEFORE the delete loop moves `ids` and returned as the tail expression (no `return` token — the rb-22
   `no-early-return` tooth still holds). The count is by construction the cardinality of the delete set: one
   serialized reducer invocation, an unconditional loop, no partial failure. The body stays a frozen contract —
   both exact-equality arms (`privacy_tests.rs`, `accounts_tests.rs`) are re-frozen to the new tail by the
   tester, with the positive control (`rb22p_machinery_comment_string_blind`) re-deriving the literal from
   source text so the pin is provably satisfiable.
2. **The claim reducer emits, terminally.** `complete_guest_claim` binds the count
   (`let purged = crate::privacy::purge_export_bundles(ctx, guest);`) and, as the LAST statement before
   `Ok(())` — after `consume_claim_and_disarm` and the AUTH-21 provenance update — calls
   `crate::observability::mr_log("guest_claim_export_purge", &claim_purge_fields(guest, purged))`.
   The placement is load-bearing: the host writes a reducer's log line as the reducer runs, and the line
   survives a later panic or `Err` that rolls the transaction (including the purge's deletes) back. Emitting
   after every fallible statement means a "purged N" line can only exist for a transaction that also
   committed — the mirror image of the ADR-0185 D1 trade-off (there: commit before a fallible write could
   discard the outcome; here: emit after nothing can discard the purge). A tooth pins the emission as the
   terminal statement and bans a `return` token anywhere in `[purge, Ok(())]`.
3. **The fragment is a pure function.** `fn claim_purge_fields(guest: Identity, chunks: usize) -> String`
   renders `"guest":"<64 hex>","chunks":N` — the `heartbeat_fields` precedent (ADR-0180): a pure builder the
   unit tests can call, composed by `build_log_line` into
   `{"evt":"guest_claim_export_purge","guest":"<hex>","chunks":N}`. It reads no table, takes no `ctx`, and
   carries no player-authored field — PRV1-17/PRV1-20 (M22 §6) are applied BY ANALOGY (their SHALL text names
   `delete_account`, `cancel_account_deletion` and the reaper, not the claim), because the failure they
   describe — "a helpful line emitted at the moment of erasure that logs the very name being erased" — is
   exactly the trap a purge line invites.
4. **Unconditional.** The line is emitted on every successful claim, `chunks` may be `0`. A claim with no
   pre-claim chunks is precisely the negative an erasure audit needs, and a conditional emission is a
   dead-branch mutant surface the rb-22 teeth were built to reject (`[call/depth0]`).
5. **The guest identity is logged as a field.** The audit key of an erasure is its SUBJECT. The `account` row
   already persists the guest→claimer linkage (`claimed_from`, AUTH-21), so the hex is not a new disclosure;
   `"sender":"{me}"` at INFO level is repo-wide precedent (`npc.rs`, `movement.rs`, `battle.rs`, `pvp.rs`).
   ADR-0180 D12's "identity hex permitted in WARN/ERROR lines only" records what that audit FOUND
   (`log_reject`), not a blanket severity rule — D12's actual ban is identity as a Prometheus/Loki LABEL, and
   the Alloy label set stays bounded to `{reducer, evt}`. The line is a best-effort host-log signal, not a
   durable commit record.

## Alternatives rejected

- **Emit inside `privacy.rs`.** Contradicts the module's gate-enforced doctrine (the `log::` ban carries the
  reason "the reducer that calls the helper owns any logging"); the owner-generic helper cannot name its CAUSE
  (claim vs cascade vs re-export) without a signature change to all three pinned call sites; and it would put
  the first emission into the one file whose entire hygiene contract exists to keep it scanner-inert (the evt
  string would have to be `stringify!`, the quote a char constant).
- **A private audit/event table.** A new `#[table]` needs `schema.rs` (outside `touches:`) and the ADR-0221
  automigration freeze requires table + writer to land atomically — a hidden-dependency STOP, and far
  oversized for one line.
- **Emit with no count.** Leaves the helper untouched (no re-freeze) but the line becomes a constant that
  cannot distinguish a purge of 0 from one of 12 and cannot carry a behavioural tooth; the rb-22 static pins
  already say "control reached here".
- **A separate `count_export_bundles` pre-scan.** Two index walks, a count of what was ABOUT to be deleted, and
  a second `pub(crate)` fn in `privacy.rs` wanting its own frozen pin.
- **`mr_log_breadcrumb` with `cause`.** A `cause` would duplicate the guest field and drags the trace-pair
  machinery (G9f/G9h, eval A10) into a slice that needs none of it.

## The gate set

RED arm (compiles on the pre-fix tree, fails by name): `rb40_claim_emits_one_purge_observation` (exactly one
`crate::observability::mr_log(` in the reducer and file-wide, zero breadcrumbs, terminal-statement pin
`...mr_log(,&claim_purge_fields(guest,purged));Ok(())`, ordering purge < consume < update < emit < Ok, depth 0,
no `return` in `[purge, Ok(())]`, `let purged` bound once, no `#[cfg(` in the emission's item span),
`rb40_claim_binds_the_purge_result`, `rb40_evt_and_fragment_literals_are_pinned` (strings-kept view: the exact
call, the evt token and the fragment literal each exactly once; no reserved envelope key, no `name` /
`auth_issuer` / `claimed_from`), `rb40_claim_purge_fields_is_pure` (signature, privacy, no `ctx`/`.db.`/write
verb/log segment), `rb40_no_new_bare_log_in_accounts_or_privacy` (the OBS-2 needles at zero, by name);
`rb40p_purge_returns_the_collected_count` (sig ends `->usize`, body ends `}purged`, `let purged = ids.len();`
once and before the loop). GREEN arm (calls the new fn — cannot compile pre-fix, lands with the fix, the rb-22
EO-6 precedent): `rb40_claim_purge_fields_is_exact`, `rb40_claim_purge_line_composes_into_the_envelope`.
Re-frozen: the four `privacy_tests.rs` literals (`rb22p_frozen_body/sig/body_source/decl_source`), the two
`accounts_tests.rs` literals, and rb-22 clause (2) — now `;letpurged=crate::privacy::purge_export_bundles(ctx,guest);`.

## Honest limits / residuals

1. **The cascade and re-export call sites discard the count** (`account_deletion_reaper`, accounts.rs;
   `request_data_export`, privacy.rs). Cascade-wide observability is its own design — thirteen delegated
   erase steps want ONE line, not thirteen — and touches every owning module. Residual R-rb40-CASCADE.
2. **No dashboard consumes the event.** `ops/observability/**` is outside `touches:`; the line is queryable
   in Loki under the bounded `{reducer, evt}` label set, which is the shipped consumption path. R-rb40-DASH.
3. **ADR-0220's Decision 3 still spells the old `purge_export_bundles(ctx, owner)` signature.** An `Amends:`
   marker would force a reciprocal `Amended-by:` edit inside ADR-0220 (outside the reserved-number allowance),
   so this ADR `Extends:` it and the stale prose is R-rb40-ADR0220. R-rb-22-EO-10 (the REKEY_MANIFEST reason
   text) stays open.
4. **No LIVE behavioural proof.** The count is proven structurally (exact-body pin) and the fragment
   behaviourally (pure fn); a live `account-e2e` phase that exports, claims and greps the host log for the
   line is outside `touches:` (`evals/`). The rb-22 EO-9 wording asked for observability, not a live rig.

## Consequences

- Every successful guest claim leaves one greppable `guest_claim_export_purge` line carrying the retired
  guest and the number of export chunks erased — and only for transactions that committed.
- `accounts.rs` gains its first backslash-escaped quote bytes (the `format!` fragment). Measured clean
  against every whole-crate scanner: four of the five distinct strippers are escape-aware by construction,
  the other two never look at quotes (rb-40 plan red-team).
- The OBS-2 ratchet is untouched: no bare `log::`, no `use log`, `.log-baseline` byte-identical.
- The helper's widened return type is warning-free at the two sites that ignore it (`usize` carries no
  `must_use`; clippy runs the default lint set with `-D warnings`), so their pinned call text is unchanged.
