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
   entry only. No string or regex fallback exists in the engine. Shapes the engine RECOGNISES as
   unseeable — the refusal list in D2 — are hard errors, never approximated into a verdict; shapes
   outside its vocabulary altogether (an expression-position macro body, a raw datastore write) are
   recorded as LIMITS under Consequences, which is a different claim from "safe".
2. **The corpus is derived, never listed, and the walker refuses what it cannot see through.** The
   engine parses `lib.rs` and takes `lib.rs` itself plus every `mod x;` it ACCEPTS → `src/x.rs`. The
   crate-root `mod` rule is an attribute-SET rule: the empty set is scanned; a set of nothing but `doc`
   attributes is scanned (doc attrs are ignored); any set containing exactly `cfg(test)` is skipped
   whatever else it carries (`path`, `allow`, anything). Every other set is refused — a cfg other than
   `cfg(test)`, a `path` with no `cfg(test)` — and so is an INLINE `mod x { }` at the crate root. Inside
   a scanned module, any `mod` at all — inline or file — that carries no `cfg(test)` is refused. The
   classified table set is read from the REAL `schema::DATA_LIFECYCLE_MANIFEST` (policy ≠ `NotOwned`, 24
   tables today) and the owner roster from the REAL `game_core::STATE_TRANSITION_OWNERS` — the compiler
   supplies both, so a manifest edit or a new owner re-derives the census with no transcription.

   The remaining hard errors (`CensusError::UnsupportedShape` unless named otherwise), each refused
   rather than reported as "no writes":
   - item-position macro invocations and `macro_rules!` definitions — at item level AND inside fn
     bodies;
   - `use … as …` renames: item level, body level, the group forms, and `extern crate … as …`.
     `use … as _` binds no name and is accepted;
   - a fn pointer, meaning ANY path to a crate fn in non-call position (`let f = helper;`, `&helper`,
     `helper as fn(..)`, `Some(helper)`), resolved qualified-only (same module, `self::`, `crate::`,
     `m::`) with whole-fn value-binding shadowing honoured — a struct-literal field shorthand such as
     `PlaytestEvent { hp_permille }` beside a same-module `fn hp_permille` is the VALUE, not the fn;
   - `#[procedure]` on a fn;
   - an `impl` fn whose signature mentions `ReducerContext` or a handle type;
   - any fn whose SIGNATURE — parameters, generics, where-clause, return type — mentions a handle type
     (a `…TableHandle` suffix, `Table<…>`, `impl Table`; `EncounterTable` never matches). One carve-out:
     a ctx or handle mention inside a bare fn TYPE's PARAMETER list does not count, because that shape
     aliases a callback and `privacy.rs`'s exporter-delegate registry
     `type ExportRows = fn(&ReducerContext, Identity) -> …` is exactly it; the same type's RETURN
     position does count;
   - a `type` alias whose right-hand side mentions `ReducerContext` or a handle type;
   - UFCS write spellings: `Table::delete(..)`, `<H>::insert(..)` with a qself, any call path whose tail
     is a write verb;
   - a `crate::`-rooted call path with more than one module segment;
   - a gate-named fn defined outside `guards`/`accounts` (a shadow definition);
   - a duplicate reducer name (`DuplicateReducer`), an unparseable file (`Parse`), and a missing module
     file (`MissingModuleFile`, for `NotFound` only — any other io error is reported as a parse failure
     carrying its real cause rather than masquerading as an absent module);
   - new in this slice: a HANDLE CHAIN outside a sanctioned position (D3), and a writing non-owner
     SCHEDULED reducer with no scheduler guard (D5).
3. **"Writes a manifest-classified table" is transitive, alias-aware, and readable only in sanctioned
   positions.** A write is an `insert` / `try_insert` / `update` / `delete` / `clear` /
   `insert_or_update` / `try_insert_or_update` method call whose receiver chain contains a zero-argument
   call named as a classified accessor (`ctx.db.monster()…`, including index handles), or whose chain
   root is a `let`-bound handle alias (`let battles = ctx.db.battle();` in `pvp.rs` is real; a
   row-returning chain such as `.find(..)` or `.iter()` is not a handle).

   A HANDLE CHAIN — a receiver chain of zero-argument calls, none of them `iter`/`count`/`len`, none of
   them a write verb, reaching a classified accessor or a bound alias — may appear in exactly two
   positions: as a method-call receiver, or as the initialiser of a bare-ident `let` (through `&` and
   parentheses). ANYWHERE else it is a hard error naming the enclosing fn: a tuple or array element, a
   call argument, an assignment right-hand side, a block tail, an `if`/`match` arm, a `for`-loop
   iterable, a struct field, a closure tail, a return value. In those positions the handle escapes into
   a value the census cannot follow, so it is refused rather than approximated.

   Alias DISCOVERY may cross a field base; a WRITE's alias root may not. That asymmetry is what makes
   `row.move_queue.clear()` on a found row a non-write while `battles.battle_id().update(row)` through
   the alias is one. Writes reached through crate-local helper calls count for the reducer that calls the
   helper (`f`, `m::f`, `crate::m::f`, `self::f`, resolved same-module first, then to every crate fn of
   that name — over-approximation is the fail-closed direction); closure bodies are walked; and
   cfg-paired twin fns sharing a (module, name) BOTH contribute their writes, so keeping only one of the
   pair would lose the other's.
4. **"Preceding guard call" means a depth-0 statement of the reducer's own body, before the first
   write-reaching statement, in one of exactly two fully-qualified shapes** — the ADR-0248 D1 needles:
   (a) `crate::guards::require_not_deleting(..)?;` /
   `crate::guards::require_subject_not_deleting(..)?;` /
   `crate::guards::require_commitment_predates_deletion(..)?;` as an expression statement; or (b) an
   `if` whose condition IS the pending-deletion call — `crate::accounts::is_pending_deletion(..)`, the
   ADR-0246-sanctioned export-gate spelling, bare only inside `accounts.rs` itself — whose then-branch's
   LAST statement is `return <expr>` with `<expr>` not `Ok(..)`. Shape (b) is an EXACT call: a compound
   condition (`flag && pred`), a negated one (`!pred`, `flag && !pred`) or any otherwise-wrapped form is
   not a gate, because the branch then decides on something else as well; and `return Ok(())` is a
   silent commit, not a refusal. A gate inside a helper, inside a nested block, with a discarded
   verdict, or after the first write is NOT a gate either — widening this is how the gate becomes a
   no-op. The raw predicates are deliberately NOT gate spellings here (ADR-0246: a module consuming them
   chooses both the subject and what to do with the verdict).

   **What this engine relies on others for (recorded by the security lens).** Shape (b)'s SUBJECT and
   the gate ARGUMENTS are not inspected here at all: `require_subject_not_deleting`'s identity argument
   is held honest by rb-76's per-module containment count of the raw predicate (ADR-0246,
   `guards_tests.rs`), and `require_commitment_predates_deletion`'s stamp by ADR-0237's `respond_trade`
   pins. If rb-76's clause is ever relaxed, shape (b) becomes a third-party-subject channel with no
   remaining fence.
5. **Structural exemptions are exactly three and their sets are pinned.** `STATE_TRANSITION_OWNERS`
   members (they own the transition). LIFECYCLE reducers — attribute argument `init` /
   `client_connected` / `client_disconnected`, host-invoked — on two different grounds: `init` and
   `on_disconnect` are exempt because the presence bookkeeping they write is what the cascade itself
   tombstones, while `on_connect` is exempt because its `provision_or_touch_account` terminal arm
   re-provisions an erased account (it updates the row to fresh defaults, clearing the terminal marker),
   which is the sanctioned PRV1-8(b) reactivation path the operator ruled in ADR-0228 D4 (issue #403) —
   not presence bookkeeping, and the reason a gate there would be wrong. SCHEDULED reducers (the
   reducer's name appears as the ident inside a table attribute's `scheduled(<name>)`), and here the
   exemption is VERIFIED rather than assumed: a scheduled reducer that is not an owner and reaches a
   classified write must open with `if ctx.sender() != ctx.database_identity() { … return … }` as its
   FIRST depth-0 statement or the census hard-errors. All nine of the crate's scheduled reducers do.
   Write-free scheduled reducers and owners are exempt from that check, earning their verdict elsewhere.
   The check also neutralises "schedule donation" — hanging a `scheduled(<name>)` attribute on a
   `cfg(test)` or foreign-macro struct to buy a reducer the exemption — because the donated exemption
   still demands the guard. Precedence is Owner > Lifecycle > Scheduled > NoClassifiedWrites > Gated >
   Ungated (`account_deletion_reaper` is an owner). Because lifecycle and scheduled are a widening of
   the EARS's "owners only", the real-crate test pins both verdict sets EXACTLY, so a new structural
   exemption is a conscious edit, not a free ride.
6. **Everything else that writes is either gated or a ROSTER ENTRY WITH A BASIS, and the roster is
   pinned exactly in both directions.** `DELIBERATE_EXEMPTIONS: &[(&str, &str)]` mirrors
   `DATA_LIFECYCLE_MANIFEST`'s mandatory-`basis` shape and ADR-0257's exactly-pinned migration debt: the
   real-crate test asserts the engine's ungated set equals the roster names as a SET — a newly ungated
   writer fails CI (rb-45's EARS), and a stale entry whose reducer got gated or deleted fails too, so
   paying debt down is a conscious edit. Never a count, never a floor (ADR-0224 amendment). FIVE basis
   classes at ship time, 25 rows in total:
   - (i) acts on an already-open commitment, which PRV1-10 / ADR-0227 D5 keep completable — nine
     reducers (`submit_attack`, `swap_active`, `flee`, `use_battle_item`, `submit_pvp_action`,
     `cancel_trade`, `confirm_trade`, `cancel_challenge`, `decline_challenge`). Each of them reaches two
     INSERT-IF-ABSENT helpers on the way out: `economy::grant_currency` (`player_wallet`) and
     `evolution::check_and_evolve` (`pending_evolution_notice`). That is accepted under PRV1-10 because
     during the grace window nothing has been erased yet, so the update arm runs, and any row a helper
     does mint is swept by the cascade at terminal time. The post-terminal case — a battle still
     `Ongoing` after the cascade ran — is the registered residual `R-rb-45-ONGOING-BATTLE`, not a claim
     of safety.
   - (ii) `respond_trade`, whose decline arm unwinds the offer BEFORE the stamp-aware accept gate by
     design (ADR-0237).
   - (iii) `sync_content`, operator-only behind the owner-identity guard.
   - (iv) KNOWN GAP — the 13 gameplay writers spec §4.7 names as gate targets that no slice has gated
     yet (`join_game`, `evolve`, `care`, `train`, `essence_train`, `consume_crystalized_essence`,
     `attempt_recruit` — which inserts a brand-new monster for the caller — `set_nickname`,
     `set_party_slot`, `enqueue_move`, `set_move`, `clear_queue`, `dismiss_dialogue`). The predicate
     that puts a reducer here rather than in class (i) is "creates or mutates the caller's assets",
     not merely "acts on an already-open commitment". Debt with a drain — residual `R-rb-45-DRAIN`, one
     reject test per reducer — not a decision that they stay ungated.
   - (v) `ack_evolution_notices`, which acts only on the caller's own existing notice queue (find the
     sender's row, then update; never an insert); ADR-0254 keeps the evolution banner dismissable
     during grace by decision, not by omission.

   The roster pins WHICH reducers are ungated, not WHAT they write: the assertion prints each ungated
   reducer's write set and helper chain so a widening is visible in review, but it does not fail on one.
7. **Proof-of-teeth once, no recursion.** The engine is pure over `(module, source)` pairs, so the
   mandated tooth `rb45_synthetic_ungated_reducer_is_flagged` injects a synthetic ungated reducer into
   the REAL corpus and asserts the roster comparison fails. Ten tests ship:
   `rb45_synthetic_ungated_reducer_is_flagged`, `rb45_gate_after_the_first_write_is_ungated`,
   `rb45_conditional_nested_negated_or_discarded_gate_is_not_a_gate`,
   `rb45_table_handle_alias_write_is_a_write`, `rb45_helper_delegated_write_is_a_write`,
   `rb45_owner_lifecycle_and_scheduled_are_exempt_with_precedence`,
   `rb45_not_owned_and_foreign_writes_are_not_classified`,
   `rb45_both_gate_shapes_and_every_write_verb_are_recognised`,
   `rb45_unsupported_shapes_are_hard_errors` (26 refused shapes and 8 accepted ones, every refusal
   carrying its own distinct message so no catch-all can serve them all), and
   `rb45_real_crate_matches_the_rosters`, which pins the whole 54-row report as a TOTAL partition:
   3 owner + 3 lifecycle + 8 scheduled + 14 gated + 1 no-writes + 25 rostered. Each tooth is killed by
   one named engine mutation (recorded in the slice plan). No test asserts anything about another test.
8. **ADR-0224 delete-on-touch, checked:** no existing eval encodes the [DEL-06] invariant — a grep for
   `require_not_deleting`, `DEL-06` and `X18` over `evals/` hits only unrelated a11y and nightly-wiring
   files — so this migration has nothing to delete.

## Considered alternatives

- **Reviewer-checklist item only** (ADR-0224's other candidate) — rejected: the property has 51
  reducers in scope today and changes with every gameplay slice; a checklist proves nothing
  mechanically, and the S5/S3b/rb-46 history shows the width was mis-estimated by hand twice.
- **Gate the 13 known-gap reducers in this slice so the roster is empty** — rejected as scope: each is
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
- Known limits, stated:
  - expression-position macros are not walked (item- and body-level macros are hard errors), so a write
    inside `log::…!(..)` above a gate leaves a reducer `Gated`; the defence for that class is rb-78's
    anchor roster (ADR-0248), not this engine;
  - a fn pointer PASSED as an argument, or bound through a bare fn type, is not followed (the
    R-rb-80-FNPTRDELEGATE class);
  - impl/method delegation is not followed: the `impl`-fn tripwire refuses the ctx and handle
    spellings, but an alias-free method that writes through a captured field would not be seen;
  - directory modules (`src/x/mod.rs`) are reported as missing files;
  - ordinary root-rooted associated calls with two or more module segments are refused — over-strict,
    and none exist today;
  - the shadowing approximation is whole-fn, not scope-precise;
  - raw `sys::datastore_*` writes are outside the vocabulary (the R-rb-80-RAWWRITE class);
  - a roster entry's write set can widen silently (printed, not pinned), and gate arguments are not
    inspected (D4).
- This is the fourth deliberate copy of the crate-root module-roster derivation (ADR-0166 R5 lists the
  text-based siblings in `accounts_tests`/`trading_tests`/`guards_tests`); this one is syn-based and the
  only one that reads the test cfg as an attribute rather than as text.
- Residuals registered for rb-45: `R-rb-45-DRAIN` (gate the 13 class-(iv) known-gap writers, one reject
  test each) and `R-rb-45-ONGOING-BATTLE` (the post-terminal surviving-`Ongoing`-battle case) — both on
  the backlog.
- Follow-up flagged, deliberately outside this slice's touches: a one-line cross-reference beside
  `STATE_TRANSITION_OWNERS` in `game-core/src/accounts/deletion.rs` pointing at
  `DELIBERATE_EXEMPTIONS`, so whoever edits the owner roster sees the census roster too.
- `syn` compiles into the test target only; the lib/wasm artifact is unchanged.
- ADR-0225 and ADR-0228 Consequences named this mechanism as the deferred follow-up; both carry a
  dated amendment noting closure here.
