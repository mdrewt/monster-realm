# ADR-0243 — The deletion cascade and the data export each emit ONE terminal `mr_log` line carrying the purge count they used to discard

**Status:** Accepted
**Date:** 2026-09-07
**Slice:** rb-65 (residual R-rb-40-CASCADE, `M-residual-backlog.spec.md#rb-65`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0235 (the claim-time precedent this generalises — and whose third rejection reason it reverses), ADR-0228 (the §4.4 cascade and its D1 infallible `-> ()` helpers), ADR-0226 (the export reducer's pinned statement shape), ADR-0238 (the arm-last tail this re-freezes), ADR-0180 D6/D12 (`mr_log` as the sole emission point; identity as a field, never a label), ADR-0224 (proof-of-teeth as ordinary tests), ADR-0230 (whose PRV1-17/20 "emits no log line" evidence this falsifies)
**Subsystems:** security-authz, ci-gates
**Decision:** `account_deletion_reaper` and `request_data_export` bind the count `purge_export_bundles` returns and each emit ONE terminal `mr_log` line (`account_deletion_cascade`, `data_export`) carrying subject + counts, never a player-authored field.

## Context and problem statement

rb-40 (ADR-0235) made `privacy::purge_export_bundles` report the number of `export_bundle` chunks it deleted and made
`complete_guest_claim` publish that number. Its own honest-limits list named the two callers that still throw the count
away: the M22 §4.4 deletion cascade in `account_deletion_reaper` (accounts.rs), where the purge is step 6b's export
erase, and `request_data_export`'s purge-before-write (privacy.rs), where a caller's previous bundle is replaced. Both
are erasures of personal data that leave no trace in any host log, so an erasure audit cannot tell a cascade that ran
from one that never fired, nor a re-export that replaced twelve stale chunks from one that replaced none.

The residual asked for ONE cascade-wide line rather than thirteen: the cascade delegates to twelve `erase_*` /
`anonymize_*` / purge helpers across twelve owning modules (ADR-0228 D1 made every one but the rb-40 purge
deliberately `-> ()`), plus the live-interaction resolver, and a line per step would be thirteen unreviewed
emissions in thirteen files. PRV1-17 and
PRV1-20 (M22 §6) govern the reaper's log lines literally: no player-authored field, and never the erased identity's
pre-tombstone `name` or `auth_issuer` at the moment of erasure. ADR-0230 recorded both criteria as met BY ABSENCE —
"the reaper emits no log line at all" — and deferred their mechanical enforcement to "the next slice that holds
`accounts.rs` write-capable". This is that slice, for the line it adds.

Three constraints shape where and how the lines can be written. First, `privacy.rs` carries a gate-enforced
scan-hygiene contract (`rb22p_scan_hygiene`, `rb22p_no_bare_quote_in_privacy`): no `log::` token, no print macro, no
block comment, no raw string, and no double-quote byte beyond the one `#[path]` attribute — every constant string is
`stringify!`, the quote is the `JSON_QUOTE` char constant. Second, the OBS-2 ratchet (ADR-0180 D6) forbids any new bare
`log::` site; every emission routes through `observability::mr_log`. Third, the slice's `touches:` set is the two
reducers' files and their test siblings; the eleven helper-owning modules are outside it, so per-step counts cannot
land here.

## Decision

1. **Both call sites bind the count.** The reaper's step 6b becomes
   `let export_chunks = crate::privacy::purge_export_bundles(ctx, args.account_identity);` (the subject is still spelled
   from `args.account_identity` at the call — ADR-0228 RT-3's "never a local binding" rule is about the SUBJECT
   argument; the RESULT may be bound). The export reducer's purge-before-write becomes
   `let purged = purge_export_bundles(ctx, me);`. `purge_export_bundles` itself is untouched: the helper reports, the
   calling reducer owns any observation (the rb-22/rb-40 doctrine, now exercised at all three of its call sites).

2. **ONE terminal line per reducer, unconditional, at brace depth 0, after the last write.** The reaper emits
   `crate::observability::mr_log("account_deletion_cascade", &fields)` as the statement after the 6e terminal `account`
   update and before `Ok(())`; the export reducer emits `crate::observability::mr_log(stringify!(data_export), &fields)`
   as the statement after the rb-48 self-arm and before `Ok(())`. The placement generalises ADR-0235 D2's rollback
   argument from one fallible statement to a thirteen-step transaction: the host writes a reducer's log line as the
   reducer runs, and the line survives a later panic or `Err` that rolls every write back, so a line may only be
   written once nothing fallible can follow it. In the export reducer that includes the arm —
   `ensure_export_bundle_reaper` uses a plain `.insert(` (not `try_insert`), which panics and aborts the transaction on
   a constraint violation — so the emission MUST follow the arm: the arm is the last WRITE, the emission is the last
   STATEMENT. rb-48's `[E4/arm-last]` tail pin is re-frozen to the longer tail (an equally-exact pin over more text, not
   a relaxation; the ADR-0238 invariant "a chunk exists implies the singleton is armed" is unchanged because the arm
   still precedes `Ok(())` and no write follows it). A conditional emission would be a conditional audit record; the
   zero-count line is the negative an erasure audit needs.

3. **The fragments are pure private builders** (the `heartbeat_fields` / `purge_fields` precedent — no `ctx`, no table
   read, unit-tested by value):
   `fn cascade_fields(subject: Identity, export_chunks: usize) -> String` renders
   `"subject":"<64 lowercase hex>","export_bundle":N`, and
   `fn export_fields(subject: Identity, purged: usize, written: u32) -> String` renders
   `"subject":"<hex>","purged":N,"written":M` through the privacy.rs JSON micro-builder (`json_field_into`,
   `json_identity_into`, a new three-line `json_usize_into`, `json_u32_into`). `written` is the request's `total_chunks`.
   The lines compose to `{"evt":"account_deletion_cascade","subject":"…","export_bundle":N}` and
   `{"evt":"data_export","subject":"…","purged":N,"written":M}`. Two pins together prevent a forged envelope key under last-key-wins parsing, because
   `mr_log_breadcrumb`'s AM6 reserved-key `debug_assert!` compiles out of the release wasm (`Cargo.toml` leaves
   `debug-assertions` at its release default) and cannot be delegated to: the frozen BODY plus the key census (a fourth
   key, even one rendered from integer inputs, reds `[fields/key-census]` / `[fields/exact]` — measured), and the
   whole-signature freeze that bans any `&str`/`String` parameter (necessary, not sufficient — an integer-only builder
   can still be edited to render a reserved literal, which is what the body and key pins catch). Both builders take
   only `Identity` and integers: an alphabet of lowercase hex, decimals and fixed key literals. The `json_usize_into` encoder exists so the ADR-0226 width→quote rule (64-bit
   quoted, 32-bit bare) stays in one place and the bare-decimal contract is host-testable; on `wasm32` `usize` is
   `u32`, so it prevents no production truncation and is not claimed to.

4. **The extension contract for the deferred per-step counts.** The cascade line's keys after `subject` are per-step
   counts: ONE unquoted numeric key per delegated erase/anonymize/purge helper, named by the HELPER's noun (the word
   after `erase_` / `anonymize_` / the purged table — `export_bundle` today), appended at the helper's cascade position.
   Keys are never quoted, renamed or removed; a helper that learns to report widens to `-> usize` and adds exactly one
   key, re-freezing the fragment pin visibly. The live-interaction resolver (step 6a) is not an erasure and carries no
   count; the spec's "thirteen steps" counts it, so the key space is twelve. Table nouns were rejected as keys because
   eight of the helpers span several manifest tables (`erase_monsters` → `monster` + `monster_pub`, …) and
   `player_wallet` is not `wallet`. Landing the other eleven counts needs the eleven owning modules and an amendment
   to ADR-0228 D1 — deferred through the rb-65 acceptance ledger's X8 `DEFER: -> backlog` line, which carries that file list and
   from which the supervisor mints the residual.

5. **What the cascade line means — and what it does not.** Presence of an `account_deletion_cascade` line means every
   delegated step and the terminal stamp returned `Ok` inside a transaction the host then attempted to commit. The
   line is written PRE-COMMIT and is AT-LEAST-ONCE: a host crash or commit-log failure after the reducer returns leaves
   a line for an erasure that did not durably land, and the publish-time re-arm (`ensure_deletion_reapers_armed`) will
   then re-fire the reaper and emit a second line. Absence of a line means nothing (a dropped log pipeline is not
   evidence of non-erasure). The SSOT for "was X erased, and when" is the `account` row's `terminal_at_ms`, never the
   log — an auditor must not believe an audit trail lives in Loki.

6. **The erased identity is logged as `subject`, a log FIELD.** The audit key of an erasure is its subject (ADR-0235
   D5), and identity hex at INFO is repo-wide precedent (battle.rs, npc.rs, movement.rs, raising.rs). This line is
   materially different from the claim line — its subject is an identity the module has just promised to erase, and
   a host log is a store outside the module's reach — so the retention ORDERING is what makes it acceptable: Loki
   self-purges at 30 days (`ops/observability/loki/loki-config.yml`, `retention_period: 30d`), while the
   Anonymize-policy `account` row keeps the identity key and `terminal_at_ms` permanently, operator-only (the table is
   private). The log line is the SHORTER-lived copy of a fact the module deliberately keeps; its only reader is the
   operator behind Caddy's basic-auth Grafana route, who can already read the row. Counts-only was rejected as a
   security regression (it buys no privacy — the linkage persists in `account` regardless — and destroys per-subject
   answerability, which is what GDPR Art. 5(2)/17 demonstrability needs); a truncated or hashed subject was rejected
   as ceremony that adds prefix collisions or key material for a reader who already holds the identity list. The
   Alloy label set stays `{reducer, evt}` — the identity is never a label. The runbook's §9 caveats name rows and
   host backups but not the operational log; that sentence is G24 exact-body-checked and outside `touches:`, residual
   R-rb-65-RUNBOOK-LOGCAVEAT.

7. **The `data_export` line's `subject` is the caller's own `ctx.sender()`** — a subject-access request, not an
   erasure, whose `export_bundle` rows carry `owner_identity` durably regardless of the log. The subject is
   security-load-bearing here: the reducer is client-callable, walks seventeen tables under the global write lock and
   is DoS-governed by a per-identity cooldown, so a counts-only line could not distinguish one abusive identity from
   broad legitimate use. The three reject paths (no subject, pending deletion, cooldown) emit nothing BY DESIGN — a
   reject line would be a client-driven log-amplification vector into a 30-day store and needs its own ruling.

8. **The `evt` vocabulary is Loki label space.** Alloy's `stage.metrics` labels every line by `{reducer, evt}`, so the
   two new values are a closed, enumerable addition, never templated or derived. In accounts.rs the evt is a bare
   string literal (greppable; a `const`/`concat!` leaves identifier bytes where the blanked-view pin requires a bare
   comma). In privacy.rs it is `stringify!(data_export)` — the hygiene contract admits no quote byte — and the token
   is pinned by an exact count over the comment-stripped, whitespace-preserving source (accounts.rs's over the raw
   `include_str!` text), because the squashed views delete
   whitespace INSIDE string literals and `stringify!` output alike (an evt with an interior space is byte-identical
   in every squashed view and CI-clean otherwise).

9. **ADR-0235's third rejection reason is reversed, deliberately.** ADR-0235 rejected "emit inside privacy.rs" for
   three reasons: the owner-generic HELPER cannot name its cause; a signature change to three pinned call sites; and
   "it would put the first emission into the one file whose entire hygiene contract exists to keep it scanner-inert
   (the evt string would have to be `stringify!`, the quote a char constant)". The first two still hold and this ADR
   still never emits from the helper. The third is exactly what this slice does, because the emission belongs to the
   REDUCER that calls the helper — privacy.rs's own header says so — and the hygiene contract is a set of measured
   scanner facts, every one of which the new code satisfies: zero quote bytes (measured before and after), no `log::`
   token (`mr_log` is a function), no print macro, no cfg, and no in-file `macro_rules!` definition — the evt IS a
   macro invocation (`stringify!`), and a local `macro_rules! stringify` shadow that ships a different evt is the
   measured bypass that `rb64p_paren_less_verb_and_in_file_macro_are_banned` closes. The contract keeps the module scanner-inert; it never said the
   module may not observe its own reducer.

10. **The rb-40 emission census is widened 1→2 and repaid.** `rb40 [emit/count-in-file]` pinned `crate::observability::mr_log(`
    at exactly one in accounts.rs. A bare bump is a strict loosening; the widening is paid for as the m22-s3b purge
    census paid for its own 1→2: per-body counts (one in `complete_guest_claim`, one in the reaper), the file total,
    and `total - scoped == 0` as arithmetic, plus an alias clause — the unqualified `mr_log(` count AND the bare `mr_log` identifier count both equal the
    qualified count, and `mr_log as` is banned — so neither a re-exported wrapper nor a function-pointer binding
    (`let emit: fn(&str, &str) = crate::observability::mr_log;`, measured CI-clean against the paren-anchored
    censuses alone) can add a site the qualified needle never sees. The same identifier census holds privacy.rs at one.

## Alternatives rejected

- **Thirteen per-step lines.** Thirteen emissions in eleven files, each a separately reviewed privacy surface, for a
  fact ("this cascade ran") that is one fact.
- **Widen the eleven remaining helpers to `-> usize` now.** Eleven modules outside `touches:` — a hidden-dependency STOP — and a
  reversal of ADR-0228 D1 that deserves its own ADR. Deferred with the file list (D4).
- **A private audit table.** Needs `schema.rs` (declared but unmodified here), the ADR-0221 automigration freeze wants
  table + writer atomically, and it is oversized for two lines; the `account` row already IS the durable record (D5).
- **Emit with no count.** A constant line observes nothing and cannot carry a behavioural tooth; the rb-22/rb-24 static
  pins already say "control reached here".
- **`mr_log_breadcrumb` with a `cause`.** Duplicates the subject into a second key and drags the trace-pair machinery
  (G9f/G9h) into a causeless INFO line.
- **Emit before the arm in privacy.rs.** Keeps the rb-48 tail pin untouched but leaves a panicking `.insert(` after the
  emission — the exact shape D2 forbids.
- **`"steps":13` in the cascade fragment.** A compile-time constant re-derived from a source scan on every change: the
  check-the-checker pattern ADR-0224's amendment retired, and redundant with the key count once D4 lands.
- **`purged as u32` / `json_u32_into`.** Silent narrowing on the host; the rb-40 teeth reject the same cast.
- **A single shared builder for both lines.** Different modules with different hygiene contracts; DRY does not cross
  that boundary (a `format!` literal cannot exist in privacy.rs, and the JSON micro-builder is private to it).

## The gate set

RED arm (compiles on the pre-fix tree, fails by name): `rb65_reaper_emits_one_cascade_observation` (declaration
uniqueness; the scheduler guard at index 0 of the reaper body; one emission in the reaper, two in the file attributed
per body with zero elsewhere; alias clause; no breadcrumb; a file-wide cfg census — exactly one `#[cfg`, the tests-mod
attribute, and zero `cfg!(` — which also closes `#[cfg_attr(not(test), cfg(any()))]`; the terminal tail pinned LEFTWARD
through the `let fields` binding so `cascade_fields(args.account_identity, 0)` and `export_chunks.saturating_sub(1)`
both fail; count-before-index ordering; depth 0; no `return` token between the binding and `Ok(())` and no `?` operator anywhere in the reaper body — a
depth-0 `?` is an early exit a `return` census alone never sees, measured CI-clean; exactly THREE `return` tokens in
the whole reaper body — ADR-0228 D2's three sanctioned exits, of which exactly ONE is an `Err` (the scheduler guard,
which is also the first) and two are `Ok(())` — a prefix early return smuggled through the re-frozen literal is
otherwise CI-clean, measured; a bare-identifier `mr_log` census equal to the qualified count (a function-pointer
binding is otherwise CI-clean, measured); each binding once),
`rb65_reaper_binds_the_purge_result`, `rb65_evt_and_fragment_literals_are_pinned` (kept-strings call + evt, the raw-source
whitespace-preserving evt pin, the fragment literal scoped inside the builder, the PRV1-17/20 key ban),
`rb65_cascade_fields_is_pure` (whole frozen signature, privacy, body bans, blanked-body equality);
`rb65p_export_emits_one_observation` (the same clauses against `m22s4_reducer_body`, the `}`-anchored tail through the
arm, `let total` bound once, reachability scoped to depth 0 — no depth-0 `return` and no depth-0 `?` — with the
PRV1-11 fail-loud arm attributed at depth > 0 AND pinned as `return Err(`: an `Ok` there is a short export that
reports success, measured CI-clean against a bare token census),
`rb65p_export_binds_the_purge_result`, `rb65p_export_fields_is_pure` (whole signature, exact `stringify!` key set, the
raw-source `stringify!(data_export)` pin). GREEN arm (calls the new builders — cannot compile pre-fix, the rb-22 EO-6
precedent): `rb65_cascade_fields_is_exact`, `rb65_cascade_line_composes_into_the_envelope`, `rb65p_export_fields_is_exact`
(including the bare-decimal contract of `json_usize_into` at 0 and beyond 32 bits), `rb65p_export_line_composes_into_the_envelope`.
Re-frozen: `rb24_frozen_reaper_body` (two independent transcriptions, guard prefix intact), `rb40 [emit/count-in-file]`
(1→2 repaid), `rb48 [E4/arm-last]` (the longer tail).

## Honest limits / residuals

1. **Per-step counts are deferred** (ledger X8 `DEFER: -> backlog` with the eleven-module list; the supervisor mints the
   residual row from that line at merge). The
   cascade line carries the one count already reported and the extension contract that makes the rest additive.
2. **No live behavioural proof.** `native_host_tests.rs` models no datastore write, so neither reducer can be executed
   natively; the count's data dependency is proven by the statement pins and the fragment by value, the rb-40 shape.
3. **ADR-0230's absence evidence is now false** at "`account_deletion_reaper` emits no log line at all" and the
   PRV1-20 "holds by absence" paragraph; both criteria still HOLD — mechanically, for this line, through the key ban
   and the signature freeze — but the sentences that argued them by absence are stale. ADR-0230 is outside this slice's
   ADR allowance: residual R-rb-65-ADR0230-PRV120 (distinct from the still-open R-rb-40-ADR0230, which covers a
   different sentence). PRV1-17/20 remain gated only for the two new lines, not crate-wide.
4. **The runbook §9 caveat set omits the operational log** (D6) — residual R-rb-65-RUNBOOK-LOGCAVEAT.
5. **No dashboard consumes either evt** — R-rb-40-DASH stays open; both lines are queryable in Loki under `{reducer, evt}`.
6. **The line is pre-commit and at-least-once** (D5); it is a host-log signal, never a commit record.
7. **One prefix-exit shape stays ungated, deliberately.** A `panic!()` planted above the cascade (with the frozen literal
   regenerated around it) is neither a `return` nor a `?`, so the exit census and the `?` ban stay green (measured
   CI-clean by the artifact red-team, its only remaining shape). It is fail-LOUD — the panic aborts the transaction and
   the host records it — so under ADR-0224's amendment it is a reviewer-checklist note, not a clause; the exact close,
   if ever wanted, is a macro-invocation census over the reaper body (measured zero today).

## Consequences

- Every deletion cascade that ran to its terminal stamp and every completed data export leaves one greppable line, for
  transactions the host then attempted to commit, carrying the subject and the counts and nothing a player authored.
- `privacy.rs` gains its first emission while keeping zero quote bytes, zero `log::` tokens and exactly one `#[cfg`;
  `accounts.rs` gains a second backslash-escaped `format!` fragment, measured clean against `assertStripperSound` and the
  naive comment-first strippers (`evals/trade-escrow-guards.eval.mjs` family).
- The OBS-2 ratchet is untouched: no bare `log::`, no `use log`, `server-module/src/.log-baseline` byte-identical.
- The `purge_export_bundles` helper and its frozen-body pins are unchanged; only two of its three
  callers' use of the return value changed (the claim site already bound and published it, rb-40).
