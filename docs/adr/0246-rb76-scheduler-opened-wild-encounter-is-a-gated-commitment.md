# ADR-0246 — A scheduler-opened wild encounter is a §4.7 commitment; the grass path is gated at the `begin_encounter` choke point through the first identity-parameterised guards wrapper

**Status:** Accepted
**Date:** 2026-09-11
**Slice:** rb-76 (residual R-rb-46-GRASSPATH, `M-residual-backlog.spec.md#rb-76`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — the caller-only gate on PvE battle start; reciprocal `Extended-by:` in its header, and its GRASSPATH residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, battle, movement-netcode
**Decision:** rb-76 refuses a grass-path wild encounter for a mid-grace or terminal walker inside `battle::begin_encounter` via `guards::require_subject_not_deleting(ctx, subject)`, a non-logging identity-parameterised wrapper contained by census.

---

## Context and problem statement

M22 §4.7 forbids an account in `PendingDeletion` (or carrying the terminal marker) from opening a NEW trade,
battle or challenge commitment (PRV1-9), while PRV1-10 forbids force-terminating commitments that are
already live. ADR-0227 (m22-s5) shipped the caller-only wrapper `guards::require_not_deleting` — no identity
parameter BY SIGNATURE (D2), so no call site can point it at a third party (D4) — and ADR-0236 (rb-46)
wired it into `start_battle`, the dev-only `start_wild_battle`, `buy` and `sell`. rb-46 disclosed the one
opener it could not reach: the scheduler grass path. `movement::movement_tick` is scheduler-only
(`ctx.sender()` is the DATABASE identity), binds the walking player's identity from the character's own
`player` row, rolls the zone's encounter table and calls `battle::begin_encounter(ctx, player_identity, ..)`,
which builds and inserts the `battle` row directly. The caller-only wrapper is structurally wrong there:
gating `ctx.sender()` would gate the module itself. ADR-0236 left two questions open — whether a
scheduler-opened encounter is a §4.7 commitment at all, and what an identity-parameterised gate that does
not become the deletion-status oracle ADR-0227 D4 rejected should look like.

The seeded criterion (immutable): WHEN `movement_tick → begin_encounter` opens a wild battle for a walker
whose account is mid-grace or terminal THE SYSTEM SHALL decide (design) whether that is a §4.7 new
commitment and, if so, refuse it via an identity-parameterised seam.

## Decision

### D1 — A scheduler-opened wild encounter IS a §4.7 new battle commitment; refuse it, keep the step

A wild battle opened on grass is a `battle` row in `Ongoing` state that the §4.4 step-1 cascade would
otherwise have to force-resolve at deletion time — exactly the commitment class rb-46's own census names
("under-gating lets a mid-grace or terminal account open new commitments the deletion cascade will then have
to unwind"). That the opener is the scheduler rather than a client call changes who asks, not what is
created. So a mid-grace or terminal walker is refused the ENCOUNTER, and only the encounter: the walker's
STEP still lands (movement is world simulation, not a commitment), the encounter roll still runs
(`ctx.random()` is drawn once per eligible character and shifts no other player's roll, movement.rs R-E),
and every already-open interaction stays untouched (PRV1-10 — a walker who is mid-battle when the request
lands keeps that battle; ADR-0227 D5 / ADR-0236 D5 unchanged). The gate SERVES PRV1-10 rather than merely
respecting it: an encounter opened mid-grace is a live battle the §4.4 step-1 cascade would later have to
boot, which is the very harm PRV1-10 forbids; refusing it at the door is what keeps the cascade from ever
having to.

### D2 — The seam: `guards::require_subject_not_deleting(ctx, subject)`, the first identity-parameterised wrapper — non-logging, contained by census

```rust
pub(crate) fn require_subject_not_deleting(ctx: &ReducerContext, subject: Identity) -> Result<(), String> {
    deletion_gate(crate::accounts::is_pending_deletion(ctx, subject)).map_err(|e| e.to_string())
}
```

- **The same fused delegation as both siblings** (`require_not_deleting`,
  `require_commitment_predates_deletion`): the verdict comes from the pure `deletion_gate` over the ctx-bound
  accounts SSOT `is_pending_deletion` (ADR-0225 / ADR-0227 D1 — delegate transitively, never re-derive the
  status-or-marker disjunction) and the reject side stringifies the ONE static reason
  `REJECT_DELETION_GATED`. No new reason constant (the class ADR-0237's alternatives rejected), no new type,
  no new dependency. The body is pinned byte-for-byte (whole-body equality) like its siblings.
- **It does NOT log, and therefore takes no `reducer` tag.** `begin_encounter` returns nine `Err`s and logs
  none of them — its contract is that the CALLER owns observability, which is why the routine
  `NO_CONSCIOUS_MONSTER_REASON` is a shared constant the scheduler filters on. A wrapper that emitted
  `log_reject` here would be the only logging `Err` in that function, would fire at roughly one warn line
  per second per deleting walker on grass for the whole grace window (5 steps/s × the zone encounter rate),
  client-triggered, on a path D4 classifies as a routine non-event — and it would carry three envelope
  drifts (a non-sender in `sender`, a helper name in `reducer`, a payload tag disagreeing with the host's
  own `function` attribution). Dropping the log is what the file's other verdict helpers already do
  (`check_party_size`, `deletion_gate`, `reject_if_in_battle`), and the client path is unaffected:
  `start_wild_battle`'s own caller-only gate logs first.
- **The blanket predicate, not the stamp seam.** A grass encounter is always opened NOW, so
  `refuses_commitment_opened_at` would add nothing; it is also pinned to exactly one consumer in
  `guards.rs` (rb-47) and banned crate-wide elsewhere.
- **`require_not_deleting` is untouched.** ADR-0227 D2's structural caller-only guarantee is preserved for
  the blanket wrapper (still no identity parameter, still byte-pinned, still the only wrapper the
  `#[spacetimedb::reducer]` census in `guards_tests.rs` recognises) and is explicitly NOT claimed for the
  new one. The new seam is identity-parameterised by necessity, which makes it a potential third-party
  oracle in the ADR-0227 D4 sense; that hazard is closed the way rb-47 closed it for the stamp-aware
  accounts primitive (ADR-0237 D2/D6 — the one identity-taking primitive that already carries a crate-wide
  census): **mechanically, at build time, by a crate-wide single-consumer census** derived from `lib.rs`'s
  live `mod` declarations — exactly one declaration in `guards.rs`, exactly one call site in `battle.rs`,
  zero in every other module INCLUDING `accounts` and `schema` (rb-47 exempted `accounts` because it
  declares that seam; nothing declares this one outside `guards`) and the crate root. This is the first
  crate-wide containment of a guards-side identity-parameterised wrapper. A misuse (a counterparty-keyed
  call in `pvp.rs`, say) is a CI red, not a runtime surprise. The census needle is the BARE NAME, never
  the name plus its paren (rb-46's lesson): a function-pointer binding (`let f = crate::guards::…;`) or a
  `use … as` alias is a consumer that carries no `(`. The same census pins `begin_encounter`'s own caller
  set (`movement.rs` once, `battle.rs` twice counting the declaration, nowhere else) and `movement.rs`'s
  import binding of `begin_encounter` to `crate::battle`, because the subject is only as trustworthy as the
  caller that derives it, and a same-named twin in a third file would otherwise satisfy every pin. The
  load-bearing reason the grass gate is NOT the ADR-0227 D4 oracle is not containment alone but
  NON-OBSERVABILITY: on the scheduler path the verdict is observable to nobody — the scheduler discards
  it, `movement_tick` skips silently, nothing is logged, and the subject is the walker themselves; on the
  `start_wild_battle` path the subject IS the caller. No player ever learns another player's lifecycle
  state from this seam. Recorded honestly: the blanket
  `is_pending_deletion` itself still has NO crate-wide census — it is contained by four-file bypass bans
  and has two sanctioned non-guards consumers (`complete_guest_claim`, `request_data_export`) — a
  pre-existing hole the same census closes in passing (consequences below).
- **Names are load-bearing and prefix-free.** The bare name contains neither `require_not_deleting` nor
  `require_commitment_predates_deletion` and neither contains it: the rb-46 census pins battle.rs's bare
  count of the blanket wrapper at exactly two, and a sibling spelled `require_not_deleting_for(..)` would
  have read three — that is the shape ADR-0236 D4 anticipated and this ADR deliberately does not take.

### D3 — Placement: the `begin_encounter` choke point, after the pure checks, before the first DB read

`crate::guards::require_subject_not_deleting(ctx, player_identity)?;` — one fully
qualified, `?`-propagated statement (the ADR-0227 D2 call shape) after the pure `check_party_size` cap and
the pure duplicate-id scan, immediately before `is_in_ongoing_battle` (the first DB read) and every write
(ADR-0236 D2's "first stateful check" rule, verbatim). `begin_encounter` is the function both openers share
— `movement_tick` (the scheduler) and the dev-only `start_wild_battle` — and it is where the `battle` row is
actually built, so gating it closes the WILD/PvE opener class in `battle.rs` at function granularity, which
is what ADR-0236 admitted its reducer-granularity claim did not (the PvP openers are ADR-0227's, and one
challenger-side shape there is disclosed below). `start_wild_battle` double-gates harmlessly: its own caller gate fires
first, and the identity it passes IS `ctx.sender()`. The subject is the server-derived `player_identity`
(bound from the character's own `player` row), never `ctx.sender()`, which is the module identity on the
scheduler path.

### D4 — `movement_tick` treats the refusal as ROUTINE: a skip above the limiter, spelled the only way the ADR-0170 D4 pin admits

`REJECT_DELETION_GATED` is client-reachable at tick rate (request deletion, then walk grass), so, like
`NO_CONSCIOUS_MONSTER_REASON`, it must consume neither the `begin_encounter_error` log nor the
`BEGIN_ENCOUNTER_ERR_LIMITER` window — otherwise a deleting player could saturate the limiter and mask
genuine content faults, the exact attack the 11r-g filter closes. The existing filter is pinned as ONE
contiguous squashed sequence (`if e != NO_CONSCIOUS_MONSTER_REASON { if let Some(suppressed) =
BEGIN_ENCOUNTER_ERR_LIMITER.check(`), so folding a second reason into that condition with `&&`, an
`else if`, or a `match` would re-cut a prior slice's pin. The only admissible shape is a separate depth-0
statement immediately above it inside the `Err` arm:

```rust
if e == crate::guards::REJECT_DELETION_GATED {
    continue;
}
```

Fully qualified (unshadowable), `==` (the inverted `!=` cannot match the new pin), `continue` (the grass
block's existing no-op idiom; `?` and `return` are pinned to zero in that region because a single
character's failure must never abort the zone tick, ADR-0066). The encounter block is the last statement
of the per-character loop body, so this `continue` skips ONLY the error-log/limiter arm — if per-character
work is ever appended after the encounter block, re-examine it. No account vocabulary enters
`movement.rs`: the reason constant is the only thing it learns, and it is pinned to exactly one mention
there. COUPLING, recorded: ADR-0227 D2 defers a per-state (mid-grace vs terminal) reason split to a later
slice; if that slice introduces a second constant, this equality silently stops matching the other state
and the limiter flood returns while every rb-76 pin stays green (residual below).

### D5 — Enforcement vehicle: execution first, equality pins for what execution cannot see, a census for containment

Ordinary Rust `#[test]`s (ADR-0224; no new evals), all `rb76_`-prefixed, RED at HEAD for a predicted reason
and GREEN after:

- **Executed under the rb-41 native host** — `begin_encounter` is called directly with a NON-ZERO walker
  identity (≠ the host's fixed all-zero sender) through the five-state progression (no row / Active /
  PendingDeletion / PendingDeletion + terminal marker / row removed), with a stranger's mid-grace row seeded
  throughout (kills a table-keyed gate) and the two controls rb-46 could not write: the SENDER's own row
  mid-grace while the walker is Active must be ADMITTED (kills a `ctx.sender()`-keyed gate), and the walker
  mid-grace while the sender's row is Active must be REFUSED (kills a subject/sender swap). The wrapper is
  executed on its own over the same matrix. Honest limit (ADR-0236 consequences): every write syscall
  aborts, so the RED is "a gated walker is ADMITTED into the party lookup", never "the battle row was
  written"; ordering is owned by the source pin.
- **Source pins** — whole-body EQUALITY on the wrapper (rb-47's measured lesson: containment and
  `starts_with` pins admitted trailing-combinator and `cfg!`-keyed mutants) plus its squashed signature
  (visibility, both parameters, the return type — the assertion that makes "identity-parameterised" a
  pinned fact rather than a name); on `begin_encounter`: the qualified statement with its argument exactly
  once on the string-blanked view, PREFIX EQUALITY of everything above the gate (the sole defence
  against the whole above-the-gate class: the two early-return twins rb-46 measured and the `macro_rules!`
  residual ADR-0236 disclosed), a body-wide `#[` / `cfg!(` ban, the bare name once in the body, and the
  anchors `check_party_size(` < gate < `is_in_ongoing_battle(ctx,player_identity)` < `battle().insert(`;
  on `movement_tick`: the skip and the existing filter as one contiguous squashed sequence.
- **Census** — the crate-wide single-consumer census of D2, derived from `lib.rs` (the crate root seeded
  as a module, only `guards` exempted), with the same three anti-vacuity clauses as rb-47's (guards.rs count
  exactly one, ≥10 modules derived, the six two-player modules plus `movement` present, an unreadable
  module panics by name), and the `begin_encounter` caller census beside it.

The proof-of-teeth mutant register is executed one mutant at a time by a runner in the acceptance ledger
(`memory/projects/gates/rb-76.*`), never in this ADR body.

### D6 — Anti-decisions (restated so the successor does not re-open them)

No gate in `movement_tick` (D3's rejected alternative); no second consumer of the new seam anywhere; no
bool-returning identity oracle exported from `guards.rs`; no new reason constant; no `log_reject` in the
new wrapper (D2); no runtime "scope" precondition (below); `submit_pvp_action` and every in-flight reducer
stay ungated (ADR-0227 D5, ADR-0236 D5); `require_not_deleting`'s signature and body stay byte-identical.

## Considered alternatives

- **A runtime scope precondition** (`subject == ctx.sender() || ctx.sender() == ctx.database_identity()`,
  fail-closed with a second reason) — rejected. MEASURED: `ctx.database_identity()` is a host syscall
  (`spacetimedb_bindings_sys::identity()`) that `native_host_tests.rs` does not stub, so a wrapper reaching it
  makes the whole `monster-realm-module` test binary fail to link (`undefined symbol: identity`) — it would
  forfeit the executed vehicle ADR-0236 D4 established. It also needs a second reason constant, and it is
  not structural anyway (any scheduled reducer satisfies it); the crate already contains its identity-taking
  primitives by census, so the new seam gets the same mechanism one level up.
- **A witness type** proving scheduler provenance — rejected: prevents nothing (any caller can construct it
  from a scheduled reducer) and would be the first type in a type-free module.
- **Gate in `movement_tick` before the roll** (a silent `continue`) — rejected: it drags account vocabulary
  into `movement.rs`, needs a second consumer, the grass-region pins forbid `?`/`return` so the verdict
  would have to be discarded with `.is_err()`, it keys the gate on the CALL PATH rather than on what is
  created — `begin_encounter` would stay an ungated opener for any future caller — and, the hardest
  objection, a pre-roll skip changes the number of `ctx.random()` draws a tick makes, so one walker's
  deletion state would shift every later character's encounter seed in that tick (the cross-character
  coupling movement.rs's R-E discipline exists to prevent). Gating both — rejected: all of that cost, no
  additional security, and it breaks the single-consumer census.
- **Treat the encounter as world simulation and leave it open** — rejected (D1).
- **Log the refusal from the wrapper** (`log_reject(reducer, subject, e)`, the sibling shape) — rejected
  (D2): a warn per refused encounter on a routine path, three envelope drifts, and a helper that logs where
  its host function never does. Logging the SENDER instead would additionally hide which walker was refused.

## Consequences and residuals

- The gated set of §4.7 openers now closes at FUNCTION granularity in `battle.rs`: `start_battle`,
  `start_wild_battle` (caller-only wrapper, rb-46) and `begin_encounter` (subject wrapper, this ADR).
  `guards.rs` gains its first identity-parameterised wrapper; ARCHITECTURE.md's guards row and the deletion
  paragraph are updated; ADR-0236's GRASSPATH residual is discharged by a dated amendment there.
- A mid-grace or terminal walker keeps walking, keeps drawing an encounter roll per grass step, and is
  refused only when a roll would have opened a battle — silently, like a fainted party (D1/D2/D4): by
  design, not a residual. The deletion request itself is the logged event.
- **Residual (backlog, R-rb-76-REASONSPLIT):** the `movement_tick` skip is keyed by equality on
  `REJECT_DELETION_GATED`; the per-state reason split ADR-0227 D2 defers would silently un-filter one state
  (D4). Whoever splits the reason must extend the skip and its pin in the same slice.
- The blanket `accounts::is_pending_deletion` had no crate-wide containment (only four-file bypass bans),
  so a new module could consult it about a third party with no test seeing it. The rb-76 census closes that
  pre-existing hole in passing: its bare name may appear only in `accounts` (declaration + the claim flow),
  `guards` (the two wrappers) and `privacy` (the caller-keyed export check), zero elsewhere.
- **Residual (backlog, R-rb-76-RB47PROSE):** `trading_tests.rs`'s rb-47 assertion prose states that "a
  SECOND guards wrapper that DOES take an identity parameter ... is exactly the third-party deletion-status
  oracle ADR-0227 D4 forbids" and that the pure verdict seam serves "BOTH deletion wrappers ... across five
  reducers"; both sentences are now false as written (three wrappers, six sites, containment by census).
  Nothing reds — the clause counts the stamp seam — but `trading_tests.rs` is outside this slice's declared
  touches, so the prose rider is registered rather than smuggled in.
- R-rb-46-ERASEWRITERS (the other ERASE-policy writers — `heal_party`, `advance_dialogue`, the taming
  `grant_item` path) is unchanged by this ADR.
- Known limits, recorded honestly. (1) A `lib.rs` `#[path = "other.rs"] mod battle;` swap leaves
  `src/battle.rs` on disk, so a name-derived census scans the INNOCENT file and passes silently — it does
  not panic (the panic arm fires only when `src/<name>.rs` is missing). The census therefore also pins that
  every `#[path` attribute in `lib.rs` sits on a `*tests` module, which is the whole legitimate set today;
  a `#[cfg(target_arch)]`-selected module twin (ADR-0236's disclosed residual) remains the reviewer's to
  catch in the touches-delta audit. (2) The native host's fixed sender is the all-zero identity, which is
  also `WILD_IDENTITY` and `Identity::ZERO`, so a gate keyed on `ctx.sender()`, on `WILD_IDENTITY` or on a
  literal zero identity is indistinguishable under execution; the executed controls separate sender-keyed
  from subject-keyed only because the walker is non-zero, and the constant-keyed class rests on the body
  and call-site equality pins alone. (3) Every write syscall aborts, so gate-before-write ordering is owned
  by the source pin; `movement_tick` itself cannot execute under the host (its first row update aborts), so
  the skip's `continue` semantics are source-pinned only. (4) "Reject every real client" would be a total
  outage visible to the first e2e, not a privacy defect. (5) The prefix-equality literal must be TYPED, never
  rebuilt from the file by the test, and re-derived deliberately whenever a legitimate pure check is added
  above the gate.
- **Residual (backlog, R-rb-76-CHALLENGERGRACE):** `accept_challenge` still opens a NEW `battle` row naming
  a mid-grace CHALLENGER (A challenges B while Active, A requests deletion, B accepts — the gate there is
  caller-only on B by ADR-0227 D3/D4). ADR-0227 D4 accepted that shape on the cascade's force-resolve;
  D1 above argues the opposite for the grass path. The two are reconciled by observability, not by the
  cascade: gating the challenger's state inside `accept_challenge` WOULD be a third-party oracle (B learns
  A's lifecycle state from a distinct reject), whereas the grass gate is observable to nobody. Whether a
  generic "challenge no longer available" refusal is worth it is a PvP-slice decision; `pvp.rs` is outside
  this slice's touches.

## Confirmation

`just ci-fast monster-realm-module` runs the six `rb76_` tests (`guards_tests.rs`: the wrapper
declaration/signature/equality pin, the crate-wide single-consumer + caller census, the executed wrapper
matrix; `battle_tests.rs`: the executed five-state walker progression with the sender-vs-subject controls,
the `begin_encounter` source pin; `movement_tests.rs`: the routine-skip contiguity pin), all inside
`just ci`.
The ledger CHECK for the seeded criterion is the filtered `cargo nextest` run with the passed count pinned.
