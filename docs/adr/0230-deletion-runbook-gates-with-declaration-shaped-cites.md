# ADR-0230 — S7 deletion runbook gates: exact-sentence pins + declaration-shaped citations (G24, PRV1-17/18/20)

**Status:** Accepted
**Date:** 2026-09-02
**Slice:** m22-s7 (M22 §7.2 S7 — PRV1-17, PRV1-18, PRV1-20)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0224, ADR-0221, ADR-0226, ADR-0228
**Subsystems:** tooling-docs, ci-gates, security-authz
**Decision:** G24 enforces six §9 deletion clauses via exact-sentence pins and declaration-shaped cites. Phantom `DELETION_GRACE_MS` vs real `DELETION_GRACE_MS_DEFAULT` split is intentional. PRV1-17/20 verified; enforcement deferred to future slice.

## Context and problem statement

M22 §7.2's S7 row names three criteria:

* **PRV1-17** — WHEN `delete_account`, `cancel_account_deletion`, or the deletion reaper emits a
  log line THE SYSTEM SHALL NOT include any player-authored field in that line.
* **PRV1-18** — WHEN the DR runbook is missing or its `## Data deletion & backup retention` section
  is reworded THE SYSTEM SHALL fail CI.
* **PRV1-20** — WHEN any of those three emits a log line **at the moment of erasure or
  anonymization** THE SYSTEM SHALL NOT include the erased identity’s pre-tombstone `name` or
  `auth_issuer` value in that line. (PRV1-20 is about LOG CONTENT in the cascade window, not about
  export payloads — an earlier draft of this ADR paraphrased it as an export-side property, which
  it is not.)

ADR-0224 forbids new `evals/*.eval.mjs` scanner scripts outright, so the spec's stated vehicle
(a new `evals/account-privacy.eval.mjs` seed-set extension) would have been unavailable. S7 instead
extends the existing `evals/account-e2e.eval.mjs` (permitted by the M22 §7.2 S7 `touches:` row) with
one new gate, G24, that enforces PRV1-18 and simultaneously provides the basis for verifying PRV1-17
and PRV1-20.

## Why a doc gate is not the retired scanner class

G24 creates no new *semantic inference*: it is exact-sentence pins on a markdown file plus a citation
resolution that answers only "does the identifier this document names still exist, exactly once, as a
declaration, in the file the document names" — the question a broken-link checker answers. Its verdict
is invariant under any behavioural change that preserves the declarations. Compare to ADR-0224's
retired scanner class: `deletion-completeness.eval.mjs` would have re-derived a mental model of the
cascade from comment-stripped source text, inferring that a `ctx.db.table()` call means "this helper
deletes this table". That inference would survive arbitrary refactoring as long as the `.delete(` token
remains; a broken-link check does not. G24 is gate-valid because it is the check a broken-link
verifier would run.

## The `DELETION_GRACE_MS` / `DELETION_GRACE_MS_DEFAULT` spelling split

M22 spec §9 residual risk 2 mandates verbatim language:

> Deletion is guaranteed for the module's live queryable state within `DELETION_GRACE_MS` of the
> request. Host-level backups, snapshots, and WAL are outside the module's reach; point-in-time
> recovery can restore deleted data until the operator's backup-retention window elapses. This
> module makes no claim about backup or replica state.

**No such symbol `DELETION_GRACE_MS` exists in this codebase.** The real declaration is
`pub const DELETION_GRACE_MS_DEFAULT: i64 = 604_800_000` at `game-core/src/accounts/deletion.rs:40`.

This is not a typo to fix. The sentence is a quotation, marked as such in the ADR body and in the
eval source (`PIN_BACKUP_LIMIT`). The spelling split is intentional and load-bearing: the spec
requires exact-body checking of that sentence, so silently "fixing" it would orphan the requirement.
Decision: quote the required-exact sentence verbatim in the runbook (as shipped), and name the real
spelling in the immediately following sentence so an operator never greps for a phantom. The runbook
presently reads: "do not go looking for the shorter name. The spelling split is deliberate and is
recorded in ADR-0230." G24 clause 2 derives both the ms figure (604_800_000) and the day figure (7
days) from the real constant, so a retune that skips the runbook update is a CI failure by design.

## Declaration-shaped citation anchors, not bare identifiers

G24 clause 5 resolves five roster entries (account_deletion_reaper, AccountDeletionReaperSchedule,
export_bundle, DATA_LIFECYCLE_MANIFEST, my_export_bundle) to sole declarations by searching for
declaration-shaped markers (`pub fn account_deletion_reaper(`, `pub struct AccountDeletionReaperSchedule`,
`accessor = export_bundle)`, `pub const DATA_LIFECYCLE_MANIFEST`, `accessor = my_export_bundle,`).

Measured on this tree: every roster symbol except the grace constant occurs 2–3 times in its own file
after `stripRustComments` (attribute arguments, string literals, type positions). A bare-name
uniqueness check would have red-ed on day one. The natural fix for that red — loosening exactly-one
to at-least-one — reopens the decoy-twin bypass the uniqueness check exists to close. The roster pins
declaration shapes and reuses the already-red-teamed `requireSoleDefinition` from
`evals/deletion-grace-wasm-ssot.eval.mjs:90` rather than rolling a new one.

`DELETION_GRACE_MS_DEFAULT` is deliberately **not** in the roster: clause 2 binds its VALUE through
`parseGraceConst` (which reads the constant's actual assigned literal), which is strictly stronger
than a presence pin.

## Accepted limitation — G24 is negation-blind, and PRV1-18's "reworded" is narrower than it reads

Every clause except the two exact-sentence pins (clauses 1a/1b) and the value equality (clause 2) is a
substring test on squashed text. A same-token negating rewrite — "...this is NOT a case of no
independent TTL..." — ships green. G23 (the prior runbook gate for M21's auth runbook) has the
identical property. **G24 defends against accidental trimming and drift, not against an adversarial
editor.** This is stated plainly in the eval source and is acceptable for a runbook gate, where the
adversary is operational drift, not a malicious reviewer.

## HTML-comment stripping is load-bearing

A needle present only inside `<!-- ... -->` renders as nothing to a human but satisfies a raw
`indexOf` check. An editor could comment out the real disclaimer with the gate still green. The eval
strips HTML comments before substring matching, and there is a dedicated `html-comment-hidden` tooth
that verifies this guard itself.

### Clauses 3 and 4 are substring sets, and substring sets cannot read polarity

Measured during the artifact red-team: a sentence such as "this reaper is NOT one-shot in the way
an operator would assume" inserted beside the pinned prose keeps every clause-3 term present and
G24 green. The same holds for clause 4. This is the same limitation stated above for the gate as a
whole, restated here because clauses 3 and 4 are the ones a reader is most likely to mistake for a
semantic check: they assert the section NAMES these things, not that it describes them correctly.

## PRV1-17 and PRV1-20 — Met by verification, mechanical enforcement deferred

G24 does not mechanically verify PRV1-17 or PRV1-20 — both are properties of log CONTENT, which no
runner can prove negatively without the taint-scanner class ADR-0224 retires.
These are verified by code review of the following git:line evidence:

**PRV1-17 — every reachable log call site.** Each hop below was read directly; none is inferred
from a source scan.

- `server-module/src/accounts.rs` contains **zero** `log::`/`mr_log` calls of its own (measured).
  Its only logging path is `reject()` (`accounts.rs:515-518`), which forwards to
  `guards::log_reject` (`server-module/src/guards.rs:47-56`). `log_reject` emits one
  `log::warn!` carrying `reducer`, `sender` (an `Identity`, fixed-width hex) and `reason`.
- `delete_account` (`accounts.rs:769-799`) and `cancel_account_deletion` (`accounts.rs:804-834`)
  reach `reject()` only with **static string literals** — `"sign in required"`, `"no account"`,
  and the `const REJECT_ALREADY_DELETED` at `accounts.rs:84`. No caller-supplied or
  player-authored value can reach the `reason` parameter on these paths.
- `account_deletion_reaper` (`accounts.rs:923-958`) emits **no log line at all**; its
  scheduler-only `Err` is a static string and is returned, not logged.
- All **11** delegated cascade helpers were extracted brace-balanced and each body contains zero
  `log::`/`mr_log` calls: `monster_mgmt.rs:148`, `inventory.rs:125`, `npc.rs:464`,
  `raising.rs:765`, `economy.rs:283`, `playtest.rs:212`, `trading.rs:780`, `pvp.rs:729`,
  `privacy.rs:58`, `ranking.rs:286`, `battle.rs:1557`. (Several of those FILES do log elsewhere,
  in unrelated reducers — the distinction is per-function, not per-file.) `privacy.rs:19-28`
  additionally bans logging macros file-wide. The reaper's twelfth direct cascade call,
  `crate::erase_character_rows` (`server-module/src/lib.rs:253-257`), is not cross-module
  delegated and so is not in that list; it is a 4-line body and is likewise log-free.
- The only logging transitively reachable from the cascade is through step 6a,
  `resolve_all_live_interactions` (`server-module/src/lib.rs:240-245`), which calls exactly four
  resolvers. Their logging, traced per resolver:
  `pvp::forfeit_on_disconnect` (`server-module/src/pvp.rs:645-701`) -> `apply_pvp_forfeit`
  (`pvp.rs:382-389`, a pure delegator with no logging of its own) / `settle_pvp_battle`
  (`pvp.rs:559-602`); and `battle::resolve_wild_battle_on_disconnect` (`battle.rs:1459-1510`),
  whose ADR-0185 write-back failure line is `battle.rs:1495-1499`
  (`"evt":"wild_disconnect_writeback_err"`). Every one of those lines carries a `battle_id`
  (`u64`) and a `json_escape`d internal error string, and nothing else. No player-authored text,
  no pre-tombstone `name` or `auth_issuer`.

  (An earlier draft of this ADR cited `battle.rs:894`/`:936` here. Those are the ADR-0185
  write-back logs inside `swap_active` and `flee` — player-invoked reducers that the cascade never
  reaches. The citation was wrong; the criterion still holds, on the corrected line above.)

**PRV1-20 — the erasure window emits nothing.** PRV1-20 narrows PRV1-17 to the moment of erasure or
anonymization: no log line there may carry the erased identity's pre-tombstone `name` or
`auth_issuer`. It holds **by absence**: the reaper body emits no log line, and every helper that
performs the actual delete/update is log-free per the census above, so there is no line at that
moment into which a pre-tombstone value could be interpolated. The pre-tombstone `name` and
`auth_issuer` are read only into the `terminal_account(anonymized_account(account), now))` update
at `accounts.rs:955-958`, which writes to the table and logs nothing.

**Honest caveat.** The step-6a helpers named above were read directly, not exhaustively taint-traced,
and the two criteria are therefore verified rather than mechanically enforced. A future edit adding a
log line to any of these paths would not fail CI today.

Mechanical enforcement is deferred because the spec's named vehicle (`evals/account-privacy.eval.mjs`
seed-set extension) is both outside this slice's `touches:` row and retired as a category by ADR-0224.
The correct future target is an in-crate `#[test]` in `server-module/src/accounts_tests.rs`, on the
next slice that holds `accounts.rs` write-capable. Both PRV1-17 and PRV1-20 are currently MET BY
VERIFICATION and will be gated mechanically on that future slice.

## The `## 9.` numbering

The runbook uses a numbered house style for all `##` headings (§1–§9), deviating from the spec's bare
"## Data deletion & backup retention" heading. G24 scopes on the phrase, not the number, so PRV1-18's
spelling is honoured.

## Both required-exact sentences quoted verbatim

M22 §9 mandates their verbatim use in the ADR. As shipped in docs/observability-dr-runbook.md §9.1:

> Direct name/display fields are severed on deletion. The `Identity` key and its associated
> timestamps/behavioral history are not purged from multi-user or historical rows; this is a
> documented, accepted pseudonymization limitation, not erasure.

And:

> Deletion is guaranteed for the module's live queryable state within `DELETION_GRACE_MS` of the
> request. Host-level backups, snapshots, and WAL are outside the module's reach; point-in-time
> recovery can restore deleted data until the operator's backup-retention window elapses. This
> module makes no claim about backup or replica state.

## Measured teeth

G24 is gate-enforced by `g24Teeth()` in `evals/account-e2e.eval.mjs`. The gate measured:
- **57 of 57 teeth bite** (non-vacuous fixtures that catch real mutations and pass on the good tree).
  The suite grew twice after review: +22 from the artifact red-team (a fenced-code-block bypass, the
  unasserted `clausesMet` return, and the unproven own-property guard), and +2 from the verifier,
  which measured that clause 5's "cited symbol has no declaration" branch — the renamed-symbol case
  clause 5 primarily exists for — had no fixture at all. Two phase-0 ratchets now hold the suite:
  `G24_BAD_FIXTURES.length >= 20` and `g24.total >= G24_TEETH_FLOOR`; the first alone is not
  enough, because it does not cover the EXTRA_CHECKS half.
- **Real doc proof:** 6 of 6 clauses, 5 of 5 citations resolved

The fixtures include both synthetic bad-case variations (missing clauses, negated text, stale constants)
and a real-document GOOD case paired with every bad case, so the extraction, section-scoping, and
citation-resolution logic is all non-vacuously verified.

## Consequences

(+) PRV1-18 is now mechanically gated and exact-body-enforced, so an editor cannot drift the deletion
risk disclosures without breaking CI. The two required clauses are immutable.

(+) PRV1-17 and PRV1-20 are currently met by verification with a clear evidence chain (git:line
pointers to the source), so the spec's three deletion criteria are all satisfied and documented for
the operator.

(-) A new hand-maintained artifact: the five-entry citation roster and the six-clause layout in the
runbook, both subject to drift on future table/constant renames or file moves.

(o) PRV1-17 and PRV1-20's mechanical enforcement is deferred to a future slice that owns `accounts.rs`
write-capable. The spec requirement is met; the gate is not yet planted.
