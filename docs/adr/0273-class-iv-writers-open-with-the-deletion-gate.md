# ADR-0273 — The 13 class-(iv) gameplay writers open with the caller deletion gate; the [DEL-06] exemption roster drains to 12, and ADR-0250's OPEN classifications of `dismiss_dialogue` and `attempt_recruit` yield to the spec (rb-128)

**Status:** Accepted
**Date:** 2026-09-26
**Slice:** rb-128 (residual R-rb-45-DRAIN, promoted from source slice rb-45; M-residual-backlog.spec.md#rb-128)
**Supersedes:** —
**Amends:** —
**Extends:** 0258, 0250, 0227, 0168
**Subsystems:** security-authz, ci-gates
**Decision:** The 13 class-(iv) reducers call crate::guards::require_not_deleting as their FIRST statement; DELIBERATE_EXEMPTIONS drops to 12, EXPECTED_GATED grows to 27; ADR-0250 D5–D7 yield to the spec.

---

## Context and problem statement

M22 §4.7 (PRV1-7) requires a deletion-gated account — mid-grace (`PendingDeletion`) or carrying the terminal
marker — to be refused gameplay writes. rb-45 shipped the mechanical [DEL-06] census (ADR-0258): a syn-based
`#[test]` that partitions every reducer into owner / lifecycle / scheduled / gated / no-writes / rostered, and
pins the rostered set (`DELIBERATE_EXEMPTIONS`) exactly in both directions. Its class (iv) — "KNOWN GAP: a spec
para 4.7 gate target no slice has gated yet" — held 13 gameplay writers that create or mutate the caller's own
assets: `join_game`, `evolve`, `care`, `train`, `essence_train`, `consume_crystalized_essence`,
`attempt_recruit`, `set_nickname`, `set_party_slot`, `enqueue_move`, `set_move`, `clear_queue`,
`dismiss_dialogue`. ADR-0258 registered the drain as residual R-rb-45-DRAIN ("one reject test per reducer"),
which the supervisor promoted to this slice.

Two earlier decisions collide with that roster and are pinned by tests in this slice's `touches:`:

- **ADR-0250 D5** classified `dismiss_dialogue` OPEN by analogy to PRV1-10 (gating it "would strand a mid-grace
  player's conversation row") and byte-froze its body in `npc_tests.rs`; **D6** classified `attempt_recruit`
  OPEN ("gating an action inside an already-open battle traps the player") and pinned `consume_one(` once;
  **D7** deferred the four `raising.rs` writers BY SCOPE because their precedented placement (after
  `require_owner`, below a u64-keyed `monster` lookup) is unreachable by the rb-41 native-host five-state
  matrix; **D8** pins the file-wide bare-name count of the gate at 1 / 2 / 1 for `raising.rs` / `npc.rs` /
  `taming.rs`.
- **ADR-0258 D6** (later, Accepted) re-rostered both `dismiss_dialogue` and `attempt_recruit` as class-(iv)
  debt — `attempt_recruit` with the explicit basis "inserts a brand-new monster and monster_pub for the caller,
  a NEW asset, which is why it is debt and not class (i)" — without amending ADR-0250.

The spec section for this slice names all 13 by name. The spec is the source of truth; the ADRs are amended
to it, not the other way round.

## Decision

### D1 — Scope: all 13 class-(iv) reducers are gated; class (iv) is drained

Every one of the 13 carries `crate::guards::require_not_deleting(ctx, "<own name>")?;` — the ADR-0227 D2
caller-only wrapper, fully qualified, verdict propagated with `?`, tagged with the reducer's own name.
`DELIBERATE_EXEMPTIONS` shrinks from 25 rows to 12 (classes (i), (ii), (iii), (v) unchanged) and
`EXPECTED_GATED` grows from 14 to 27; the ADR-0258 partition of the 54-reducer corpus becomes
3 owner + 3 lifecycle + 8 scheduled + 27 gated + 1 no-writes + 12 rostered. Paying the debt down is the
"conscious edit of this roster" ADR-0258 D6 designed for; the roster file is outside this slice's declared
`touches:` and is disclosed under `touches-delta:` in the PR.

### D2 — Placement doctrine: the gate is the FIRST statement of the body

The gate precedes every other statement, including `let me = ctx.sender();`, the `monster`/`battle`/`player`
lookups, `require_owner`, and the ADR-0168 battle locks. Rationale:

1. It is forced in `movement.rs`: `authorize_move` writes the caller's `player` ack, so ADR-0258 D4 ("a depth-0
   statement before the first write-reaching statement") admits no lower placement there.
2. It is the ADR-0250 D4 (`grant_bait`) / ADR-0236 D2 ("the first stateful check") precedent, and it makes the
   ADR-0250 D7 proof-vehicle gap disappear: the native-host five-state matrix reaches the gate in every one of
   the 13 with the reducer's own first-guard reject as the positive control (`already joined`, `not joined`,
   `monster not found`, `battle not found`, or — for `dismiss_dialogue` — a real `Ok(())` on a registered
   `player_conversation` handle).
3. A prefix-equality pin ("the squashed body STARTS with the gate statement") closes every above-the-gate
   bypass class measured on earlier slices — a fixed-sender early return, a file-scope cfg constant consulted
   above the gate, a macro expanding to a conditional return (ADR-0248), an alias or import-shadowed call — in
   one clause, and it satisfies rb-78's macro grammar trivially.
4. It overrides ADR-0227 D3/D4's "after caller standing" ordering for these 13 only: a mid-grace caller naming a
   missing or foreign monster now receives the deletion reason instead of `monster not found` / `not owner`,
   and in `enqueue_move`/`set_move` the gate now precedes the ADR-0168 D2 battle lock, so a mid-grace caller
   who is also mid-battle receives the deletion reason instead of `cannot move during an ongoing battle`.
   Same verdict (refused), different message priority; it reveals strictly less, not more.

### D3 — `dismiss_dialogue` is gated; ADR-0250 D5's OPEN classification is withdrawn

PRV1-10's text (M22 §S3) protects "an already-live battle, trade, or challenge" — not a conversation. The
`player_conversation` row is transient presence state: `on_disconnect` clears it and the cascade erases the
table. The client resets its `dismissPending` in-flight flag on a reject (`main.ts`), so no button dies. The
D5 body freeze in `npc_tests.rs` becomes a gated-body pin; the file-wide count becomes 3.

### D4 — `attempt_recruit` is gated; ADR-0250 D6's OPEN classification is withdrawn

ADR-0258's basis stands: on success it inserts a NEW `monster` and `monster_pub` for the caller — exactly the
"creates the caller's assets" predicate that separates class (iv) from class (i). PRV1-10 is not violated: the
already-open wild battle stays finishable through the ungated class-(i) reducers `submit_attack`, `swap_active`,
`flee` and `use_battle_item`; only the recruit action is refused. The `consume_one(` once pin stays; the
file-wide count becomes 2.

### D5 — ADR-0250 D7 is closed by D2

`care`, `train`, `essence_train`, `consume_crystalized_essence` are gated first-statement; the five-state matrix
reaches them with `monster not found` as the positive control (the u64-keyed `monster` index is unregistered in
the fixture, so the lookup yields nothing and no `Monster` seed is needed). `raising.rs`'s file-wide count
becomes 5.

### D6 — `clear_queue` keeps ADR-0168 D3 (not battle-guarded); the deletion gate is orthogonal

The re-pinned `clear_queue` body still refuses any battle guard; the deletion gate merely precedes it. A
mid-grace player's pre-request queue (at most `MOVE_QUEUE_CAP` entries) drains through the scheduler-only
`movement_tick`, which stays ungated — `enqueue_move`/`set_move` are refused, so nothing new enters.

### D7 — Proof vehicles

- **Execution** (13 tests, `guards_tests.rs`): each reducer runs under the rb-41 native host through five account
  states — no row, `Active`, `PendingDeletion`, terminal, row removed — with a mid-grace STRANGER row seeded
  throughout; the three admitted states return the reducer's own first-guard result pinned EXACTLY, the two
  refused states return `guards::REJECT_DELETION_GATED` compared against the constant.
  - `rb128_join_game_refuses_only_a_deletion_gated_caller`
  - `rb128_enqueue_move_refuses_only_a_deletion_gated_caller`
  - `rb128_set_move_refuses_only_a_deletion_gated_caller`
  - `rb128_clear_queue_refuses_only_a_deletion_gated_caller`
  - `rb128_evolve_refuses_only_a_deletion_gated_caller`
  - `rb128_care_refuses_only_a_deletion_gated_caller`
  - `rb128_train_refuses_only_a_deletion_gated_caller`
  - `rb128_essence_train_refuses_only_a_deletion_gated_caller`
  - `rb128_consume_crystalized_essence_refuses_only_a_deletion_gated_caller`
  - `rb128_attempt_recruit_refuses_only_a_deletion_gated_caller`
  - `rb128_set_nickname_refuses_only_a_deletion_gated_caller`
  - `rb128_set_party_slot_refuses_only_a_deletion_gated_caller`
  - `rb128_dismiss_dialogue_refuses_only_a_deletion_gated_caller_and_keeps_its_row`: additionally asserts through
    the registered handle that the caller's conversation row survives ONLY in the refused states (reject-before-any-write,
    observed rather than inferred).

- **Source pins** (`guards_tests.rs`):
  - `rb128_class_iv_reducers_open_with_the_deletion_gate`: per reducer, (N) name once in the file's parsed reducer
    list; (P) blanked view: gate at body offset 0 (equality) and first statement == blanked gate statement;
    (F) bare name once in body; (E) no `#[` and no `cfg!(` in body; (T) comments-only view: text right after
    `)->Result<(),String>{` starts with `crate::guards::require_not_deleting(ctx,"<own name>")?;`
  - `rb128_gate_bearing_files_carry_exact_bare_name_totals`: bare-name totals for movement.rs 4, evolution.rs 1,
    monster_mgmt.rs 2 ONLY (raising 5, npc 3, taming 2 are owned by the re-pinned rb-80 censuses in their
    sibling files); zero raw-predicate spellings; zero occurrences in all six files of `crate::accounts::is_pending_deletion(`,
    `should_reject_for_deletion(`, or `refuses_commitment_opened_at(`.
  - `rb128_deletion_predicate_chain_is_declared_once_and_uncfgd`: anti-bypass — `should_reject_for_deletion` 
    declared once in accounts.rs + exactly 1 `#[cfg` in that file; `deletion_gate` declared once in guards.rs + 
    exactly 1 `#[cfg` in that file (closes the plan red-team's finding that a `#[cfg(not(test))]` twin of the 
    pure predicate would void every gate crate-wide).

- **The census**: `rb45_real_crate_matches_the_rosters` pins the 27-name gated set and the 12-row roster in both
  directions, so a lost gate and a stale roster row are each a CI failure.

- **Re-derived pins**: rb-80's three file censuses (`rb80_raising_reducer_roster_and_open_writers_are_pinned`
  clause (a) 1→5, `rb80_npc_reducer_roster_and_open_writers_are_pinned` clause (a) 2→3 and clause (e) frozen
  body→gated body, `rb80_taming_reducer_roster_and_open_writers_are_pinned` clause (a) 1→2 and clause (e)
  n_bare_in_body 0→1), the `clear_queue` D3 body pin (`movement_tests.rs::clear_queue_is_deliberately_not_battle_guarded`),
  and rb-78's per-module region anchors (`rb78_region_anchors` 10→13: `join_game`, `evolve`, `set_nickname` make
  `movement.rs`, `evolution.rs`, `monster_mgmt.rs` gate-bearing; `rb80_rb78_anchor_roster_covers_the_new_gate_bearing_modules`
  re-pinned 13/13).

### D8 — The three movement reducers are not a PRV1-10 "trap state"

ADR-0250's residual note R-rb-80-CRATEWIDEBARE flagged `enqueue_move`/`set_move`/`clear_queue` as "in-flight hot
path; a gate there is a trap state". That framing does not survive the spec: PRV1-10 protects an already-live
battle, trade or challenge — a multi-party commitment the cascade must unwind — and movement is none of those.
§4.7 names the three by their trigger predicate (they write `character`, an ERASE-classified table, through
`authorize_move`'s `player` ack and the queue update). Nothing traps: `cancel_account_deletion` stays an owner
(ungated) escape valve for the whole grace window, the pre-request queue drains through the scheduler-only
`movement_tick`, and a refused move leaves the character standing exactly where the server already had it.

### D9 — Test placement: the thirteen behavioural tests and both source pins live in `guards_tests.rs`

ADR-0250 D8/D9 put rb-80's tests in each file's own sibling module, and rb-76 (ADR-0246) split the wrapper
matrix (`guards_tests.rs`) from the reducer test (`battle_tests.rs`). This slice departs deliberately: one
five-state helper serves thirteen reducers, and the per-file precedent would copy that helper (and the
strippers the source pins run on) six times for no extra reach. `guards_tests.rs` already owns the caller-gate
family (m22-s5, rb-46, rb-76, rb-77, rb-78) and its m22-s5 strippers are file-agnostic. The six sibling files
keep what is theirs — the re-derived rb-80 censuses and the `clear_queue` D3 pin — and no eval requires a
reducer's gate test to live beside it (checked: `evals/` contains no scanner over `require_not_deleting`,
`is_pending_deletion`, `DEL-06` or `REJECT_DELETION_GATED`).

### D10 — Rejected alternatives

- **Gate after `require_owner` / after the joined check** (the ADR-0227 D3 ordering): needs full `Monster` seeds
  and a per-reducer prefix literal for every pin, and for `join_game` it is unprovable under the native host
  (every admitted path past the joined check reaches an insert, which aborts the process).
- **Hoist the gate into `authorize_move` / `require_owner`**: invisible to the ADR-0258 census (a gate inside a
  helper is not a gate) and would gate non-class-(iv) callers of those helpers.
- **Leave D5/D6 OPEN and gate 11**: contradicts the spec section and leaves the roster's class (iv) half-drained.
- **`**Amends:** 0250`**: `just adr-digest-check` demands a reciprocal `**Amended-by:**` line in ADR-0250, which is
  outside this slice's `touches:`; recorded as a supervisor follow-up instead.

## Consequences

- Gameplay is frozen for a deletion-gated account: no join, move, raise, evolve, rename, party edit, recruit or
  dialogue dismiss. `cancel_account_deletion` stays an owner (ungated) so the grace window is still reversible.
- `enqueue_move` — the hot path — gains one `account` primary-key point read per call.
- **Residual (client, outside touches — R-rb-128-JOINGRACE):** the client issues `joinGame` on every connection build and
  treats only the exact string `already joined` as benign (`connection.ts` `attemptJoin`); `on_disconnect` deletes the
  caller's `player`/`character` rows when the last connection closes (`lib.rs`). So a mid-grace player who reloads or drops
  gets the deletion reject on `join_game`, has NO avatar for the rest of the grace window (their monsters, wallet and account
  rows persist — nothing is erased before terminal), and sees the reject through `main.ts` `onError` → `reportError` (status
  line + error overlay; no link-level teardown, no reconnect churn). Cancelling is still possible (`cancel_account_deletion`
  needs only the account row), but the client never re-issues `joinGame` after the account returns to `Active`, so play
  resumes only on the next reload. The claim-UI `joinGame` call (`main.ts`) has no `.catch`, so the deletion reason there
  surfaces as an unhandled rejection. Client follow-up: re-join when `my_account` returns to `Active`, a "deletion pending"
  banner instead of a raw reject, and a `.catch` on the claim-UI join.
- **Residual (client, outside touches — R-rb-128-HELDKEY):** a connected mid-grace player holding a movement key gets one
  predicted step and snap-back per round trip (the reject path is the ordinary `dropRejected` → `reconcileFromStore`, no
  desync) and one `log_reject` line per refused `enqueue_move`. Client follow-up: block movement input for a gated account
  through a game-core/client-wasm-exposed predicate — never a TypeScript re-derivation of the status-or-marker rule.
- **Residual:** a conversation opened before the request (multi-tab) persists through grace until disconnect.
- **Residual (R-rb-80-REASONSCOPE grows):** `REJECT_DELETION_GATED`'s text names trades/battles/challenges only,
  yet it now also fires on join/move/raise/evolve/rename/party-edit/recruit/dismiss; it is pinned by m22-s5 and
  unchanged here. The wrapper's own doc comment in `guards.rs` is reworded in place (same line count, so no
  `path:line` citation moves) to describe the widened caller set.
- Source-pin coverage is deliberately MINIMAL on top of the ADR-0258 census: per reducer only the clauses the
  syn census cannot see — offset-0 prefix equality (a non-writing early return above the gate is invisible to a
  "before the first write" rule), the body-scoped `#[`/`cfg!(` ban (an attribute on the gate statement parses
  as a gate), the own-name tag (gate arguments are not inspected, ADR-0258 D4) and a bare-name-once clause (a
  sibling wrapper call). Reducer rosters, attribute budgets and raw-predicate containment are NOT re-pinned per
  file: the census already pins every reducer's verdict exactly and rb-76 owns the raw-predicate containment.
- Supervisor follow-ups (outside touches): `Extended-by: 0273` / dated note in ADR-0250 that D5–D7 are superseded
  by the spec; `docs/adr/README.md` index row; close R-rb-45-DRAIN (and the absorbed R-rb-80-RAISINGWRITERS) in
  the ledger and the spec.
- `docs/knowledge/reducers/*.md` line anchors and `docs/adr/DIGEST.md` are regenerated (touches-delta).
