# ADR-0258 — PRV1-7 / [DEL-06] crate-wide enforcement is ONE syn-based ordinary `#[test]` with an exactly-pinned exemption roster, not an eval scanner and not a reviewer checklist

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** rb-45 (closes residuals R-m22-s5-X11 (rb-45) and R-m22-s3b-X18 (rb-49), `M-residual-backlog.spec.md#rb-45` / `#rb-49`)
**Supersedes:** —
**Amends:** ADR-0225, ADR-0228
**Extends:** ADR-0224, ADR-0227, ADR-0246, ADR-0248, ADR-0257
**Subsystems:** security-authz, ci-gates
**Decision:** `privacy_enforcement_tests.rs` parses every `lib.rs`-declared module with `syn` and fails CI when a reducer reaches a manifest-classified write with no depth-0 `crate::guards::require_*` gate before it, unless exempt or rostered.

---

## Context

M22 §4.7 (PRV1-7) says a deletion-gated account — mid-grace (`PendingDeletion`) or carrying the terminal
marker — must be refused gameplay writes. m22-s3 shipped the pure predicate
`accounts::should_reject_for_deletion` (ADR-0225), m22-s5 fanned the `crate::guards::require_not_deleting`
call-site shape across the opening reducers (ADR-0227), m22-s3b added `set_profile_name` and recorded the
remaining ungated width as "roughly twenty-five" reducers on purpose so the residual could not be closed
by a one-reducer change (ADR-0228 §4h), rb-46/rb-47 gated `buy`/`sell`/`start_battle`/`start_wild_battle`
and the stamp-aware `respond_trade` accept path (ADR-0237), rb-76 confined the raw predicate to `guards.rs`
and `privacy.rs`'s export gate (ADR-0246), rb-77 pinned how the crate root wires its modules (ADR-0247),
and rb-78 refused macro invocations above a gate call (ADR-0248). Every one of those slices deferred the
same thing: the [DEL-06] MECHANISM that makes the property hold *mechanically* — "every reducer writing a
manifest-classified table either calls the gate or is in `STATE_TRANSITION_OWNERS`" — because its vehicle
needed the ADR-0224 ruling. ADR-0224 retired bespoke `evals/*.eval.mjs` scanners and named two candidates
for a genuine whole-crate scan with no single call site to assert against: an AST-based (`syn`) check, or
an explicit reviewer-checklist item.

The supervisor ruled (rb-45 brief): an ordinary Rust `#[test]`, syn-based, never string/regex, never a
new eval. This ADR records how that test is shaped and — the load-bearing part — how it is GREEN on a
crate where the spec's §4.7 gate is, by design and by debt, absent from 25 reducers today.

## Decision

1. **One census test module, in-crate, syn-based.** `server-module/src/privacy_enforcement_tests.rs`
   (`#[cfg(test)]`, wired at the END of `lib.rs` in the rb-77 three-line form — a top insert shifts
   executed line pins, rb-74) holds a `mod census` engine and the `rb45_*` tests. `syn` (already in
   `Cargo.lock` through the SDK's macros; `features = ["full", "visit"]` — a hand-rolled expression walk
   that misses one node variant is a hole, the visitor covers every node) enters as a `[dev-dependencies]`
   entry only. No string or regex fallback exists in the engine: a shape the parser cannot classify is a
   hard error, never an approximation.
2. **The corpus is derived, never listed.** The engine parses `lib.rs` and takes `lib.rs` itself plus
   every bare `mod x;` → `src/x.rs`. A `mod` carrying exactly `#[cfg(test)]` is skipped; any other
   attribute on a crate-root `mod`, a non-test `mod` inside a scanned module, an item-position macro,
   `use … as …`, a fn-pointer `let` binding of a crate fn, a `#[procedure]`, an `impl` fn taking a
   `ReducerContext`, a helper returning a table handle, a UFCS write spelling (`Table::delete(..)`), a
   gate-named fn defined outside `guards`/`accounts`, an unparseable file, a missing file, or a duplicate
   reducer name is a hard error (`CensusError::UnsupportedShape` et al.) — the walker refuses what it
   cannot see through instead of reporting "no writes". This is the fourth deliberate copy of the
   crate-root module-roster derivation (ADR-0166 R5 records the text-based siblings in
   `accounts_tests`/`trading_tests`/`guards_tests`); this one is syn-based and the only one that reads
   `#[cfg(test)]` as an attribute rather than as text. The classified table set is read from the REAL
   `schema::DATA_LIFECYCLE_MANIFEST` (policy ≠ `NotOwned`, 24 tables today) and the owner roster from
   the REAL `game_core::STATE_TRANSITION_OWNERS` — the compiler supplies both, so a manifest edit or a
   new owner re-derives the census with no transcription.
3. **"Writes a manifest-classified table" is transitive and alias-aware.** A write is an `insert` /
   `try_insert` / `update` / `delete` / `clear` / `insert_or_update` / `try_insert_or_update` method call
   whose receiver chain contains a zero-argument call named as a classified accessor (`ctx.db.monster()…`,
   including index handles), or whose chain root is a `let`-bound handle alias (`let battles =
   ctx.db.battle();` at `pvp.rs` is real; a row-returning chain such as `.find(..)` or `.iter()` is not a
   handle). Writes reached through crate-local helper calls count for the reducer that calls the helper
   (`f`, `m::f`, `crate::m::f`, `self::f`, resolved same-module first, then to every crate fn of that
   name — over-approximation is the fail-closed direction); closure bodies are walked.
4. **"Preceding guard call" means a depth-0 statement of the reducer's own body, before the first
   write-reaching statement, in one of exactly two fully-qualified shapes** — the ADR-0248 D1 needles:
   `crate::guards::require_not_deleting(..)?;` / `crate::guards::require_subject_not_deleting(..)?;` /
   `crate::guards::require_commitment_predates_deletion(..)?;` as an expression statement, or
   `if crate::accounts::is_pending_deletion(..) { … return … }` (the ADR-0246-sanctioned export-gate
   spelling; bare `is_pending_deletion` only inside `accounts.rs` itself). A gate inside a helper, inside
   a nested block, under a `!`, with a discarded verdict, or after the first write is NOT a gate —
   widening this is how the gate becomes a no-op. The raw predicates are deliberately NOT gate spellings
   here (ADR-0246: a module consuming them chooses both the subject and what to do with the verdict).
5. **Structural exemptions are exactly three and their sets are pinned.** `STATE_TRANSITION_OWNERS`
   members (they own the transition); lifecycle reducers (attribute argument `init` /
   `client_connected` / `client_disconnected` — host-invoked; the presence bookkeeping they write is what
   the cascade itself tombstones); scheduled reducers (the reducer name appears in a table's
   `scheduled(<name>)` attribute — every one in this crate opens with the scheduler-identity guard the
   ea/g7 tests pin, so a player can never be the caller the §4.7 gate is about). Precedence is Owner >
   Lifecycle > Scheduled > NoClassifiedWrites > Gated > Ungated (`account_deletion_reaper` is an owner).
   Because lifecycle and scheduled are a widening of the EARS's "owners only", the real-crate test pins
   both verdict sets EXACTLY, so a new structural exemption is a conscious edit, not a free ride.
6. **Everything else that writes is either gated or a ROSTER ENTRY WITH A BASIS, and the roster is
   pinned exactly in both directions.** `DELIBERATE_EXEMPTIONS: &[(&str, &str)]` mirrors
   `DATA_LIFECYCLE_MANIFEST`'s mandatory-`basis` shape and ADR-0257's exactly-pinned migration debt: the
   real-crate test asserts the engine's ungated set equals the roster names as a SET — a newly ungated
   writer fails CI (rb-45's EARS), and a stale entry whose reducer got gated or deleted fails too, so
   paying debt down is a conscious edit. Never a count, never a floor (ADR-0224 amendment). Four basis
   classes at ship time: (i) acts on an already-open commitment, which PRV1-10 / ADR-0227 D5 keep
   completable (`submit_attack`, `swap_active`, `flee`, `use_battle_item`, `submit_pvp_action`,
   `cancel_trade`, `confirm_trade`, `cancel_challenge`, `decline_challenge`); (ii) `respond_trade`, whose
   decline arm unwinds the offer BEFORE the stamp-aware accept gate by design (ADR-0237); (iii)
   `sync_content`, operator-only behind the owner-identity guard; (iv) KNOWN GAP — gameplay writers spec
   §4.7 names as gate targets that no slice has gated yet (`join_game`, `evolve`, `care`, `train`,
   `essence_train`, `consume_crystalized_essence`, `attempt_recruit`, `set_nickname`, `set_party_slot`,
   `enqueue_move`, `set_move`, `clear_queue`, `dismiss_dialogue`, `ack_evolution_notices`). Class (iv) is
   debt with a drain (a registered residual, below), not a decision that those reducers stay ungated.
   The roster pins WHICH reducers are ungated, not WHAT they write: the assertion prints each ungated
   reducer's write set and helper chain so a widening is visible in review, but it does not fail on one.
7. **Proof-of-teeth once, no recursion.** The engine is pure over `(module, source)` pairs, so the
   mandated tooth injects a synthetic ungated reducer into the REAL corpus and asserts the roster
   comparison fails; sibling teeth cover gate-after-write, conditional/negated/discarded gates, the
   handle alias, helper delegation, the three exemptions with precedence, NotOwned and foreign writes,
   both gate shapes with every write verb, and the hard-error shapes. Each tooth is killed by one named
   engine mutation (recorded in the slice plan). No test asserts anything about another test.
8. **ADR-0224 delete-on-touch, checked:** no existing eval encodes the [DEL-06] invariant — a grep for
   `require_not_deleting`, `DEL-06` and `X18` over `evals/` hits only unrelated a11y and nightly-wiring
   files — so this migration has nothing to delete.

## Considered alternatives

- **Reviewer-checklist item only** (ADR-0224's other candidate) — rejected: the property has 51
  reducers in scope today and changes with every gameplay slice; a checklist proves nothing
  mechanically, and the S5/S3b/rb-46 history shows the width was mis-estimated by hand twice.
- **Gate the 14 known-gap reducers in this slice so the roster is empty** — rejected as scope: each is
  a reducer-file edit outside rb-45's touches and a security-semantics change needing its own reject
  tests (the rb-46 shape). The roster makes the drain a pinned, visible edit per reducer.
- **Prove it from derive metadata in-crate, the ADR-0229 shape** — the sibling M22 invariant
  (deletion completeness) rejected source scanning in favour of the row types' own derive metadata.
  Not applicable here: no derive carries "which reducer wrote this table"; the fact lives only in
  reducer bodies, which is exactly the whole-crate-scan case ADR-0224 reserves the `syn` escape hatch
  for.
- **Reducer-body-only walk (no call graph)** — rejected: the spike found writes delegated through
  `economy::grant_currency`, `erase_*`/`rekey_*` and same-module helpers; a body-only walk reports them
  as "no writes" — the unsafe direction.
- **A name-based method call graph for `impl` fns and trait objects** — rejected under ADR-0224's
  moderation clause; the crate has three `impl` blocks and none takes a `ReducerContext`, so a five-line
  tripwire (hard error on the first one that does) buys the same safety.
- **Compiler-enforced newtype (a token only the gate can mint, required by every write)** — the
  strongest form, but it is a whole-crate API redesign touching every reducer and the SDK's table
  handles; recorded as the eventual illegal-states-unrepresentable target, out of scope here.

## Consequences

- Positive: [DEL-06] is mechanical from this merge on — a new reducer that reaches a classified write
  without a depth-0 gate fails `cargo nextest` in `just ci`; a newly classified table is in scope
  automatically; a fourth `STATE_TRANSITION_OWNERS` entry is exempt automatically (and still trips the
  three existing roster pins in `accounts_tests.rs`, `game-core/src/accounts/deletion_tests.rs` and
  `game-core/tests/m22_s1_deletion_surface.rs`).
- The 25-entry roster is the honest measurement of the §4.7 debt today. It is coincidentally also
  ADR-0228's "roughly twenty-five", but not the same set: rb-46/rb-47 gated four of those and
  `ack_evolution_notices` (ADR-0254) did not exist then. The class-(iv) drain is registered as a
  residual so it is queued work, not prose.
- **Ordering is load-bearing in both directions, and the wrong fix is always a roster row.** A new
  write-reaching statement inserted ABOVE an existing gate (an audit-row insert, say) demotes a gated
  reducer to ungated — hoist the gate, never add the reducer to the roster. A gate placed inside a shared
  helper is not recognised (`battle.rs`'s `begin_encounter` carries `require_subject_not_deleting` and is
  harmless today only because its sole caller is scheduled-exempt) — hoist it to the reducer's depth 0.
- Known limits, stated: the walker does not see through macro invocations (item-position macros are a
  hard error; expression-position ones — `log::…!`, `format!` — are not walked, and no crate-local
  `macro_rules!` exists); a raw `sys::datastore_*` write is outside the vocabulary (the rb-80 RAWWRITE
  class); a handle passed as a typed parameter (none exists) would not be resolved; a fn pointer bound
  by `let` is a hard error, one passed as an argument is not followed (R-rb-80-FNPTRDELEGATE); and a
  roster entry's write set can widen silently (printed, not pinned).
- `syn` compiles into the test target only; the lib/wasm artifact is unchanged.
- ADR-0225 and ADR-0228 Consequences named this mechanism as the deferred follow-up; both carry a
  dated amendment noting closure here.
