# ADR-0250 — The caller-only deletion gate reaches the heal spend, both NPC dialogue openers and the dev bait grant; the remaining ERASE-policy writers in those files are classified deliberately, by census, not left unread

**Status:** Accepted
**Date:** 2026-09-12
**Slice:** rb-80 (residual R-rb-46-ERASEWRITERS, `M-residual-backlog.spec.md#rb-80`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — the same wrapper reaches PvE battle start and the shop; reciprocal `Extended-by:` appended to its existing header line, and its ERASEWRITERS residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, economy-quests
**Decision:** rb-80 gates raising::heal_party, npc::talk, npc::advance_dialogue and dev taming::grant_bait with guards::require_not_deleting right after caller standing, and pins every other writer in those files as deliberately open by census.

---

## Context and problem statement

M22 §4.7 fixes the deletion gate's trigger predicate as EVERY reducer writing an `ERASE`/`ANONYMIZE`/`JOIN_ONLY`
table that is not a state-transition owner, and says in terms that the builder does not get to re-decide it —
`player_wallet` and `inventory` are `ERASE`-policy tables, which is why ADR-0236 (rb-46) gated the shop. The same
predicate selects three sites rb-46 disclosed and could not touch (all outside its `touches:`):
`raising::heal_party` (spends currency through the shop's own `spend_currency`, consumes items, updates
`monster`/`monster_pub`, upserts `heal_cooldown` — all `ERASE`), `npc::advance_dialogue` (dialogue-effect item
grants, `player_quest` inserts, `player_dialogue_state` writes, `player_conversation` updates and deletes) and "the
taming recruit `grant_item` path". The crate-wide PRV1-7 mechanism (`[DEL-06]`) that would select them automatically
is unbuilt (residuals R-m22-s3b-X18 / R-m22-s5-X11), so the seeded criterion (immutable) asks for a per-site decision:

> WHEN `raising::heal_party`, `npc::advance_dialogue` (quest turn-in grants) or the taming recruit `grant_item` path
> writes an ERASE-policy table (player_wallet/inventory) for a mid-grace or terminal caller THE SYSTEM SHALL refuse
> before the write (or the PRV1-7 mechanism SHALL classify each deliberately).

Two of the residual's three attributions were measured wrong before planning, and both corrections shape the
decision:

1. **Quest turn-in grants do not happen in `advance_dialogue`.** `apply_quest_trigger` — whose `QuestComplete` arm
   grants the reward items and currency — has exactly ONE caller in the crate, `talk` (the `Talked` trigger), and the
   only shipped quest completes on a Talk step. `advance_dialogue`'s own `ERASE` writes are the dialogue-choice
   `GrantItem` effects, `StartQuest` inserts, the dialogue-state write and the conversation update/delete. Gating
   `advance_dialogue` alone would leave the harm the criterion names open one reducer over.
2. **No recruit path calls `grant_item`.** The `taming.rs` call the residual points at is inside `grant_bait`, a
   `#[cfg(feature = "dev_reducers")]` dev reducer with no caller-standing check at all, compiled into the CI-built dev
   wasm. `attempt_recruit` consumes bait through `consume_one` inside an already-open wild battle.

## Decision

### D1 — `raising::heal_party` is gated

`crate::guards::require_not_deleting(ctx, "heal_party")?;` sits immediately after the caller-joined lookup and before
the character lookup — the `start_wild_battle` placement (ADR-0236 D2/D3), before every other read and every write. The
reducer debits `player_wallet` through the very helper `buy` uses, so §4.7's shop ruling applies to it verbatim.

### D2 — `npc::talk` is gated, although the criterion names `advance_dialogue`

`crate::guards::require_not_deleting(ctx, "talk")?;` after the joined lookup, before the character lookup and every
NPC read. `talk` is the sole caller of `apply_quest_trigger`, reaches `grant_item` through the auto-effects router,
inserts `player_quest`, inserts or updates `player_conversation` and writes `player_dialogue_state`. This is the
ADR-0236 D3 shape exactly — same file, same class, one line — and leaving it ungated would make this ADR's class claim
false. The extension beyond the criterion's named reducer is disclosed on the ledger as X7.

### D3 — `npc::advance_dialogue` is gated, above its reject-path deletes

`crate::guards::require_not_deleting(ctx, "advance_dialogue")?;` after the caller's own conversation lookup and the
joined lookup, before the character lookup. It must sit there and no lower: the next four guards DELETE the
conversation row on their reject arms (a write on the refuse path), and two of them log through `log::warn!`, which
ADR-0248's grammar refuses above any gate.

### D4 — dev `taming::grant_bait` is gated, as the first check

`crate::guards::require_not_deleting(ctx, "grant_bait")?;` directly after `let me = ctx.sender();`, before the item
read — there is no standing guard to follow, so ADR-0236 D2's `start_battle` reading ("the first stateful check")
applies. Gated for the reasons `start_wild_battle` was (ADR-0236 D3): it is the literal `grant_item` path the residual
names, and it ships in the dev wasm the e2e drives. `client/e2e/recruit.spec.ts` calls it with an `Active` account and
is unaffected.

### D5 — `npc::dismiss_dialogue` is classified OPEN (PRV1-10), and pinned

Its whole body deletes the caller's own transient conversation row and opens nothing. Refusing it would strand a
mid-grace player with a row they cannot clear once D2/D3 land (`talk` can no longer replace it and
`advance_dialogue`'s dismissing arms are behind the gate) — the trap state PRV1-10 forbids; the cascade erases the
table regardless. The classification is an ASSERTION, not a snapshot: the census test byte-freezes the squashed body.

### D6 — `taming::attempt_recruit` is classified OPEN (PRV1-10), and pinned

Its bait `consume_one` and, on success, the new `monster`/`monster_pub` rows happen INSIDE an already-open wild
battle behind ownership and `Ongoing` guards — the `submit_attack`/`use_battle_item` class ADR-0227 D5 and ADR-0236 D1
refuse to gate (`battle.rs`'s own `consume_one` is ungated). Gating it would make a legally opened battle
unfinishable, i.e. force-termination at request time. The monster insert is the harm PRV1-10 accepts for the battle's
duration and PRV1-6b erases afterwards. Pinned: `consume_one(` exactly once inside its body.

### D7 — `train`, `care`, `essence_train`, `consume_crystalized_essence` are deferred BY SCOPE, not by class

§4.7's predicate selects them too (they consume `inventory` and update `monster`/`monster_pub`); no "value creation"
class line is claimed. They are outside the seeded criterion, and their only precedented placement — after
`require_owner`, which sits below a u64-keyed `monster` lookup and `is_in_ongoing_battle` — is unreachable by the
native-host five-state matrix this slice proves the named sites with (admitted and refused states both stop at
"monster not found"), so they need their own proof vehicle. Registered as R-rb-80-RAISINGWRITERS with that remedy.
Their absence of a gate is VISIBLE, not silent: the file-wide count in D8 reads exactly one.

### D8 — The criterion's second arm is mechanical, per file, in ONE census test per file

`rb80_{raising,npc,taming}_reducer_roster_and_open_writers_are_pinned` (in each file's own sibling test module,
over its own strippers — ADR-0003) pin, for `raising.rs` / `npc.rs` / `taming.rs`:

- the file-wide BARE-NAME count of the caller gate: 1 / 2 / 1 — a gate hoisted into a helper, an alias binding, a
  wrapper around the wrapper, or a gate on any other reducer in the file reds it (every alias shape measured bumps
  the file count even where a body count stays zero);
- the reducer ROSTER: the count of `#[spacetimedb::reducer` equals the count of the bare `#[spacetimedb::reducer]`
  (no `reducer(name = ..)` wire-name twin), the exact fn-name SET after each bare attribute is
  {care, train, heal_party, essence_train, consume_crystalized_essence} / {talk, advance_dialogue, dismiss_dialogue} /
  {attempt_recruit, grant_bait}, and — because attribute macros can be imported or reached through a crate alias
  (`use spacetimedb::reducer;` + `#[reducer]`, `use spacetimedb as stdb;` + `#[stdb::reducer]`, a renamed import, or
  `#[spacetimedb::procedure]`, all measured invisible to the literal needle while publishing a client-callable
  `ERASE` writer) — the file's TOTAL attribute-opener budget `#[` is pinned (8 / 5 / 6) and every `::reducer` token
  must be a bare attribute;
- the conditional-compilation census: `#[cfg` 2 / 1 / 3, `cfg!(` 0, `debug_assertions` 0, `target_arch` 0 — the
  file-scope cfg-const-below-the-gate and the cross-file `target_arch` twin (both measured CI-clean without it);
- the write-verb census: raising `spend_currency(` 1, `consume_one(` 3, `grant_item(` 0; npc `grant_item(` 2,
  `grant_currency(` 1, `apply_effects_to_db(` 3, `apply_quest_trigger(` 2; taming `grant_item(` 1, `consume_one(` 1 —
  an in-file twin that duplicates a write is a count change;
- D5's body freeze and D6's body pin.

This is NOT a claim on the unbuilt crate-wide `[DEL-06]`: it covers exactly three files.

### D9 — Proof vehicles: execution first, source pins for what execution cannot see, the rb-78 roster re-derived

- **Execution** (`rb80_*_is_refused_only_while_the_caller_is_deletion_gated`, four tests): the shipped reducers run
  under the rb-41 native host through five account states with a mid-grace STRANGER row seeded throughout; the three
  admitted states return the ordinary next-guard error pinned EXACTLY (`character not found` for the three joined
  reducers — the statement directly after the gate — and `item not found` for `grant_bait`), the two refused states
  return `REJECT_DELETION_GATED` compared against the constant. `grant_bait`'s test is `#[cfg(feature =
  "dev_reducers")]` with its seeds inlined; it runs under `--features dev_reducers` only (see Consequences).
- **Source pins** (`rb80_*_carries_the_deletion_gate`, four tests): the fully qualified `?;` statement exactly once,
  at depth 0, on a statement boundary, no `#[`/`cfg!(` in the body, bare name once, the whole squashed prefix above
  the gate EQUAL to a hand-typed literal (the rb-79 shape, ADR-0249 D2 — chosen over a ported rb-46 clause-I census
  because these files spell rejections `return Err("..".to_string());`, not `return Err(e);`), a whole-body early-exit
  census (`return` count == `return Err(` count), the before/after/write anchors ordered, the tag equal to the
  reducer's own name on the strings-intact view, and for `advance_dialogue` the five conversation deletes all below
  the gate. Substrate: all three files' string strippers blank the DELIMITERS too (unlike `economy_tests.rs`), so the
  gate needle on the blanked view is `(ctx,)?;`; `taming_tests.rs` strips strings BEFORE comments, so a double quote
  inside a comment would blank code to the next quote with no residue — a measured, CI-clean bypass of the prefix
  freeze — and its substrate precondition now requires every double quote in `taming.rs` to live outside a comment.
- **The rb-78 anchor roster** (`rb78_region_anchors`, ADR-0248 D4's "one anchor per gate-bearing module") grows
  from seven to ten (`fnheal_party(`, `fntalk(`, `fngrant_bait(`; `advance_dialogue` is covered by `talk` exactly as
  `propose_trade` is by `respond_trade`), so the macro grammar's region slicer is asserted to reach the three new
  modules; `rb80_rb78_anchor_roster_covers_the_new_gate_bearing_modules` pins all ten members at distinct split points.
  ADR-0248's "seven anchors", "five gate-bearing modules" and "ten live sites" statements describe the tree as of
  rb-78; after this slice the numbers are ten anchors, eight modules and fourteen sites (the four gates here plus the
  ten it counted). The extension is RED at HEAD by itself (the anchors resolve to no region until the gates exist).

### D10 — Anti-decisions

No new wrapper, no new reason constant (ADR-0227 D2, ADR-0246 D2: one static reason per gated shape), no
helper-level gating (`apply_effects_to_db`/`apply_quest_trigger` take an owner identity, would need the
census-contained subject wrapper, and would fire twice per `talk`), no use of `require_subject_not_deleting` (pinned
to one consumer), `guards.rs` byte-identical, no eval added or grown (ADR-0224), every in-flight reducer stays open,
no signature freeze at the four sites (the execution tests call them positionally, so an added parameter is a compile
error; a type swap of an existing parameter is disclosed under R-rb-80-BELOWGATE).

## Considered alternatives

- **Gate `advance_dialogue` only** — rejected: the named harm lives in `talk` (Context).
- **Gate inside `apply_effects_to_db` / `apply_quest_trigger`** — rejected (D10).
- **Gate `dismiss_dialogue` / `attempt_recruit`** — rejected (D5/D6: trap state / in-battle).
- **Gate the four other raising writers now** — rejected by scope and by proof vehicle (D7); sized at four inserts
  plus four source-pin tests with no executed proof.
- **A dialogue-specific reason constant** — rejected (D10); the client maps no server reject string today.
- **A crate-wide reducer-roster census** — out of right-size; the shape exists
  (`rb76_subject_gate_and_begin_encounter_are_contained_crate_wide`) and is named in R-rb-80-CRATEWIDEBARE.
- **A new eval scanner, or a CI job for the dev-feature test** — rejected (ADR-0224; a `justfile`/workflow edit is a
  hidden dependency), registered as R-rb-80-DEVFEATURETEST.

## Consequences

- The caller-only gate now guards twelve reducers across eight files (was eight across five). A mid-grace or terminal
  player can no longer heal at a heal location, open an NPC dialogue or advance one; they can still dismiss a
  dialogue, finish or flee a battle, recruit inside one, train, care and use essence. The refusal text still says
  "new trades, battles and challenges are unavailable" (R-rb-80-REASONSCOPE); no client change is needed or made.
- Exactly two lines were inserted per site (one comment, one statement), so the knowledge-bundle stamps for
  `advance_dialogue`, `dismiss_dialogue`, `essence_train` and `consume_crystalized_essence` moved by two or four lines
  and the bundle was regenerated; line citations into these files below the inserts drift accordingly (three ADR
  citations repointed here: ADR-0248's two `guards_tests.rs` lines, ADR-0183's `raising.rs:503`, ADR-0184's
  `taming.rs:295`; the pre-existing stale ones are R-rb-80-CITEDRIFT).
- `ADR-0236`'s ERASEWRITERS residual bullet is discharged by a dated amendment there; `ARCHITECTURE.md`'s "remaining
  disclosed openers" sentence is corrected in place.
- The executed proof for `grant_bait` runs in no `just` recipe or CI job (`cargo nextest run --workspace` uses default
  features; `clippy --all-features` compiles it without running it) — the ADR-0236 D3 posture, now made explicit by
  the ledger's dev-feature full-suite gate (X2) and R-rb-80-DEVFEATURETEST.
- Proof-of-teeth on the REAL files is the ledger's X6 mutant register (`memory/projects/gates/rb-80.mutants.py`,
  record in `rb-80.red-before.md` §5-§6): 28 of 28 M-rows KILLED on a designated clause — each gate dropped, a
  discarded verdict, a tag swap, a gate moved below its site's first write (all four sites), an attribute on the
  statement, an import-shadowed call, a duplicate, a constant or inverted verdict in the pure seam, the seven
  ADR-0249 above-the-gate shapes, a wire-name twin, an aliased-attribute twin, a below-gate delegation duplicating a
  write, a gate added to each deliberately-open or deferred reducer, an anchor deleted from the roster, and the
  comment-quote substrate attack — with a comment above a gate, a deleted site comment and a below-gate `let me =`
  rebinding as the three CONTROL-GREEN rows. Two verifier-class rows chosen by the red-team SURVIVE and are registered
  rather than pinned: a sender-keyed raw `ctx.db.player_wallet()` / `ctx.db.inventory()` write below a gate
  (R-rb-80-RAWWRITE).

## Residuals registered (targets: backlog)

- **R-rb-80-RAISINGWRITERS (MED)** — `train`/`care`/`essence_train`/`consume_crystalized_essence` still write
  `inventory`/`monster` ungated; §4.7 selects them; deferred by scope with the proof-vehicle remedy in D7.
- **R-rb-80-BELOWGATE (MED)** — the region below each gate is unpinned beyond the return census and the anchors: a
  below-gate `let me = <other identity>;` rebinding, or a type swap on an existing parameter carrying an identity,
  passes every pin (R-rb-79-BELOWGATE's class, two new shapes).
- **R-rb-80-CRATEWIDEBARE (MED)** — the caller gate's bare name and the reducer roster are censused per file (eight
  files now); no crate-wide census enumerates client entry points, so an ungated `ERASE`/`ANONYMIZE`/`JOIN_ONLY`
  writer in any other module — added later, in any attribute spelling, OR ALREADY PRESENT — is invisible to every
  rb-80 pin. The reducer-security-auditor enumerated the present ones against the manifest: `movement::join_game`
  (inserts `character`/`player` and, after the cascade emptied the account, a fresh starter `monster`/`monster_pub`
  — the sharp one, but its reachability is the operator-blocked PRV1-8 ruling, spec §4.1), `evolution::evolve`,
  `monster_mgmt::set_nickname`, `monster_mgmt::set_party_slot`, `movement::enqueue_move`/`set_move`/`clear_queue`
  (in-flight hot path; a gate there is a trap state) and `privacy::request_data_export` (writes `export_bundle`;
  deliberately OPEN — the §5 export right exists because deletion was requested). The next slice inherits this list.
- **R-rb-80-RAWWRITE (MED)** — the D8 write-verb census counts helper NAMES; a below-gate statement writing through
  a raw table accessor (`ctx.db.player_wallet()..update(..)`, `ctx.db.inventory().insert(..)`), sender-keyed so the
  fixed native-host sender never takes it, duplicates no counted verb, adds no `return`, and sits outside the frozen
  prefix. Measured against the shipped suite: see the register record (rows M24/M25) for which gates caught it; the
  ADR-0081 single-surface evals are the compensating control for `player_wallet` and the closed form is a per-body
  closed write set, which no census in this crate has yet.
- **R-rb-80-DIALOGUECOMMITMENT (LOW)** — `advance_dialogue` uses the BLANKET gate on what can be an already-open
  conversation (opened by `talk` while the account was still `Active`), where `respond_trade` uses the stamp-aware
  `require_commitment_predates_deletion` (ADR-0237). Not exploitable with shipped content (the one quest completes
  inside a single `talk`), but a future multi-turn tree or multi-step Talk quest would lose its progress the moment
  the player requests deletion; `player_conversation` carries no opened-at stamp to key the sibling on.
- **R-rb-80-CITEDRIFT (LOW)** — pre-existing `raising.rs:NNN`/`npc.rs:NNN` comment citations in
  `raising_tests.rs`, `npc_tests.rs`, `content_cache_tests.rs`, `battle_tests.rs`, `economy_tests.rs`,
  `guards_tests.rs`, `evals/monster-dual-write.eval.mjs`, `client/e2e/wallet-balance.spec.ts`, `ARCHITECTURE.md:1284`
  and ADR-0170 were stale before this slice and drift further with it; comments only.
- **R-rb-80-REASONSCOPE (LOW)** — one static reason names trades/battles/challenges and now fires on heal/talk/bait.
- **R-rb-80-DEVFEATURETEST (LOW)** — the dev-feature executed proof runs in no CI job.
