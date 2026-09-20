# ADR-0258 — PRV1-7 / [DEL-06] crate-wide enforcement is ONE syn-based ordinary `#[test]` with an exactly-pinned exemption roster, not an eval scanner and not a reviewer checklist

**Status:** Accepted
**Date:** 2026-09-20
**Slice:** rb-45 (closes residuals R-m22-s5-X11 (rb-45) and R-m22-s3b-X18 (rb-49), `M-residual-backlog.spec.md#rb-45` / `#rb-49`)
**Supersedes:** —
**Amends:** ADR-0225, ADR-0228
**Extends:** ADR-0224, ADR-0227, ADR-0257
**Subsystems:** security-authz, ci-gates
**Decision:** `privacy_enforcement_tests.rs` walks every `lib.rs`-declared module with `syn`, follows crate-local calls transitively, and fails CI when a reducer reaches a manifest-classified write without a depth-0 deletion-gate statement before it, unless it is an owner, a lifecycle/scheduled reducer, or a roster entry carrying a basis.

---

## Context

M22 §4.7 (PRV1-7) says a deletion-gated account — mid-grace (`PendingDeletion`) or carrying the terminal
marker — must be refused gameplay writes. m22-s3 shipped the pure predicate
`accounts::should_reject_for_deletion` (ADR-0225), m22-s5 fanned the `guards::require_not_deleting`
call-site shape across the opening reducers (ADR-0227), m22-s3b added `set_profile_name` and named
`join_game` and roughly twenty-five other manifest writers as the known ungated width (ADR-0228 §4h),
and rb-46/rb-47 gated `buy`/`sell`/`start_battle`/`start_wild_battle` and the stamp-aware
`respond_trade` accept path (ADR-0237). Every one of those slices deferred the same thing: the
[DEL-06] MECHANISM that makes the property hold *mechanically* — "every reducer writing a
manifest-classified table either calls the gate or is in `STATE_TRANSITION_OWNERS`" — because its
vehicle needed the ADR-0224 ruling. ADR-0224 retired bespoke `evals/*.eval.mjs` scanners and named two
candidates for a genuine whole-crate scan with no single call site to assert against: an AST-based
(`syn`) check, or an explicit reviewer-checklist item.

The supervisor ruled (rb-45 brief): an ordinary Rust `#[test]`, syn-based, never string/regex, never a
new eval. This ADR records how that test is shaped and — the load-bearing part — how it is GREEN on a
crate where the spec's §4.7 gate is, by design and by debt, absent from 25 reducers today.

## Decision

1. **One census test module, in-crate, syn-based.** `server-module/src/privacy_enforcement_tests.rs`
   (`#[cfg(test)]`, wired at the END of `lib.rs` — rb-74 measured that a top insert shifts executed
   line pins) contains a `mod census` engine and the `rb45_*` tests. `syn` (already resolved
   transitively in `Cargo.lock`; pinned to that version) enters as a `[dev-dependencies]` entry only.
   No string or regex fallback exists anywhere in the engine: a shape the parser cannot classify is
   reported, never approximated.
2. **The corpus is derived, never listed.** The engine parses `lib.rs`, takes `lib.rs` itself plus
   every `mod x;` not under `#[cfg(test)]`, and reads `src/x.rs`. A missing file, a non-test inline
   `mod x { }`, a `#[path]` on a non-test `mod`, a `macro_rules!` item in a scanned module (the one
   construct the walker cannot see through), an unparseable file, or a duplicate reducer name is a
   hard error, not a skip. The classified table set is read from the REAL
   `schema::DATA_LIFECYCLE_MANIFEST` (policy ≠ `NotOwned`) and the owner roster from the REAL
   `game_core::STATE_TRANSITION_OWNERS` — the compiler supplies both, so a manifest edit or a new
   owner re-derives the census with no transcription.
3. **"Writes a manifest-classified table" is transitive and alias-aware.** A write is an
   `insert`/`try_insert`/`update`/`delete` method call whose receiver chain contains a zero-argument
   call named as a classified accessor (`ctx.db.monster()…`, including index handles), or whose chain
   root is a `let`-bound alias of such a chain (`let battles = ctx.db.battle();` at `pvp.rs` is real).
   Writes reached through crate-local helper calls count for the reducer that calls the helper
   (`f`, `m::f`, `crate::m::f`, `self::f`); an unresolvable bare name resolves to every crate function
   of that name — over-approximation is the fail-closed direction.
4. **"Preceding guard call" means a depth-0 statement of the reducer's own body, before the first
   write-reaching statement.** Two shapes are recognised, exactly the two the crate uses:
   `<gate>(…)?;` (an expression statement whose expression is `?` over a call to
   `require_not_deleting` / `require_commitment_predates_deletion` / `require_subject_not_deleting` /
   `is_pending_deletion` / `should_reject_for_deletion` / `refuses_commitment_opened_at`), and
   `if <condition containing such a call> { … return … }`. A gate inside a helper, inside a
   conditional without a return, or after the first write is NOT a gate — widening this is how the
   gate becomes a no-op.
5. **Structural exemptions are exactly three, all "no player caller".** `STATE_TRANSITION_OWNERS`
   members (they own the transition), lifecycle reducers (`init` / `client_connected` /
   `client_disconnected` — host-invoked, and the presence bookkeeping they write is what the cascade
   itself tombstones), and scheduled reducers (a parameter typed as a struct carrying a `scheduled(…)`
   table attribute — private to the scheduler in 2.x, and their first statement is the scheduler
   guard). A reducer with no classified writes is reported as such and needs no gate.
6. **Everything else that writes is either gated or a ROSTER ENTRY WITH A BASIS, and the roster is
   pinned exactly in both directions.** `DELIBERATE_EXEMPTIONS: &[(&str, &str)]` mirrors
   `DATA_LIFECYCLE_MANIFEST`'s mandatory-`basis` shape and ADR-0257's exactly-pinned migration debt:
   the real-crate test asserts the engine's ungated set equals the roster names as a SET — a newly
   ungated writer fails CI (rb-45's EARS), and a stale entry whose reducer got gated or deleted fails
   too, so paying debt down is a conscious edit. Never a count, never a floor (ADR-0224 amendment).
   Four basis classes at ship time: (i) acts on an already-open commitment, which PRV1-10 / ADR-0227 D5
   keep completable (`submit_attack`, `swap_active`, `flee`, `use_battle_item`, `submit_pvp_action`,
   `cancel_trade`, `confirm_trade`, `cancel_challenge`, `decline_challenge`); (ii) `respond_trade`,
   whose decline arm unwinds the offer BEFORE the stamp-aware accept gate by design (ADR-0237);
   (iii) `sync_content`, operator-only behind the owner-identity guard; (iv) KNOWN GAP — gameplay
   writers spec §4.7 names as gate targets that no slice has gated yet (`join_game`, `evolve`, `care`,
   `train`, `essence_train`, `consume_crystalized_essence`, `attempt_recruit`, `set_nickname`,
   `set_party_slot`, `enqueue_move`, `set_move`, `clear_queue`, `dismiss_dialogue`,
   `ack_evolution_notices`). Class (iv) is debt with a drain (a registered residual, below), not a
   decision that those reducers stay ungated.
7. **Proof-of-teeth once, no recursion.** The engine is pure over `(module, source)` pairs, so the
   mandated tooth injects a synthetic ungated reducer into the REAL corpus and asserts the roster
   comparison fails; sibling teeth cover gate-after-write, conditional gate, alias, helper delegation,
   the three exemptions, a NotOwned write, both gate shapes, a `cfg`-hidden reducer, and the hard
   errors. Each tooth is killed by exactly one named engine mutation (recorded in the slice plan). No
   test asserts anything about another test.

## Considered alternatives

- **Reviewer-checklist item only** (ADR-0224's other candidate) — rejected: the property has 51
  reducers in scope today and changes with every gameplay slice; a checklist proves nothing
  mechanically, and the S5/S3b/rb-46 history shows the width was mis-estimated by hand twice.
- **Gate the 14 known-gap reducers in this slice so the roster is empty** — rejected as scope: each
  is a reducer-file edit outside rb-45's touches and a security-semantics change needing its own
  reject tests (the rb-46 shape). The roster makes the drain a pinned, visible edit per reducer.
- **Reducer-body-only walk (no call graph)** — rejected: the spike found writes delegated through
  `economy::grant_currency`, `erase_*`/`rekey_*` and same-module helpers; a body-only walk reports
  them as "no writes" — the unsafe direction.
- **Compiler-enforced newtype (a token only the gate can mint, required by every write)** — the
  strongest form, but it is a whole-crate API redesign touching every reducer and the SDK's table
  handles; recorded as the eventual illegal-states-unrepresentable target, out of scope here.
- **Extending an existing eval (`account-privacy`, `guest-claim-integrity`)** — forbidden by ADR-0224
  and its "grow no existing eval" reading.

## Consequences

- Positive: [DEL-06] is mechanical from this merge on — a new reducer that writes a classified
  table without a depth-0 gate fails `cargo nextest` in `just ci`; a new table classified in the
  manifest is in scope automatically; a fourth `STATE_TRANSITION_OWNERS` entry is exempt
  automatically (and `m22s9_bindings_expose_m22_surface` still pins the roster).
- The 25-entry roster is the honest measurement of the §4.7 debt (ADR-0228 said "roughly
  twenty-five"); the class-(iv) drain is registered as a residual so it is queued work, not prose.
- Known limits, stated: the walker does not see through macro invocations (no crate-local
  `macro_rules!` exists; a new one is a hard error), function pointers / closures stored and
  invoked later are followed only where they are direct `ExprCall` paths, and a table handle passed
  as a typed parameter (none exists) would not be resolved — a reviewer adding any of these shapes
  re-derives the engine deliberately.
- `syn` compiles into the test target only; the lib/wasm artifact is unchanged.
- ADR-0225 and ADR-0228 Consequences named this mechanism as the deferred follow-up; both carry a
  dated amendment noting closure here.
