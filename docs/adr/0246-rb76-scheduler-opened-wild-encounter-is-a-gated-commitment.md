# ADR-0246 — A scheduler-opened wild encounter is a §4.7 commitment; the grass path is gated at the `begin_encounter` choke point through the first identity-parameterised guards wrapper

**Status:** Accepted
**Date:** 2026-09-11
**Slice:** rb-76 (residual R-rb-46-GRASSPATH, `M-residual-backlog.spec.md#rb-76`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — the caller-only gate on PvE battle start; reciprocal `Extended-by:` in its header, and its GRASSPATH residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, battle, movement-netcode
**Decision:** rb-76 refuses a grass-path wild encounter for a mid-grace or terminal walker inside `battle::begin_encounter` via `guards::require_subject_not_deleting`, an identity-parameterised wrapper contained by a crate-wide single-consumer census.

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
lands keeps that battle; ADR-0227 D5 / ADR-0236 D5 unchanged).

### D2 — The seam: `guards::require_subject_not_deleting(ctx, reducer, subject)`, the first identity-parameterised wrapper, contained by census

```rust
pub(crate) fn require_subject_not_deleting(
    ctx: &ReducerContext,
    reducer: &str,
    subject: Identity,
) -> Result<(), String> {
    deletion_gate(crate::accounts::is_pending_deletion(ctx, subject)).map_err(|e| {
        log_reject(reducer, subject, e);
        e.to_string()
    })
}
```

- **Same fused single-expression shape as both siblings** (`require_not_deleting`,
  `require_commitment_predates_deletion`): the verdict comes from the pure `deletion_gate` over the ctx-bound
  accounts SSOT `is_pending_deletion` (ADR-0225 / ADR-0227 D1 — delegate transitively, never re-derive the
  status-or-marker disjunction), the reject side is one `.map_err` that calls `log_reject` and stringifies
  the ONE static reason `REJECT_DELETION_GATED`. No new reason constant (the class ADR-0237's alternatives
  rejected), no new type, no new dependency. The body is pinned byte-for-byte (whole-body equality) like its
  siblings.
- **The blanket predicate, not the stamp seam.** A grass encounter is always opened NOW, so
  `refuses_commitment_opened_at` would add nothing; it is also pinned to exactly one consumer in
  `guards.rs` (rb-47) and banned crate-wide elsewhere.
- **`require_not_deleting` is untouched.** ADR-0227 D2's structural caller-only guarantee is preserved for
  the blanket wrapper (still no identity parameter, still byte-pinned, still the only wrapper the
  `#[spacetimedb::reducer]` census in `guards_tests.rs` recognises) and is explicitly NOT claimed for the
  new one. The new seam is identity-parameterised by necessity, which makes it a potential third-party
  oracle in the ADR-0227 D4 sense; that hazard is closed the same way the crate already closes it for its
  two identity-taking accounts primitives (ADR-0237 D2/D6): **mechanically, at build time, by a crate-wide
  single-consumer census** derived from `lib.rs`'s live `mod` declarations — exactly one declaration in
  `guards.rs`, exactly one call site in `battle.rs`, zero in every other module. A misuse (a
  counterparty-keyed call in `pvp.rs`, say) is a CI red, not a runtime surprise.
- **Names are load-bearing and prefix-free.** The bare name contains neither `require_not_deleting` nor
  `require_commitment_predates_deletion` and neither contains it: the rb-46 census pins battle.rs's bare
  count of the blanket wrapper at exactly two, and a sibling spelled `require_not_deleting_for(..)` would
  have read three — that is the shape ADR-0236 D4 anticipated and this ADR deliberately does not take.

### D3 — Placement: the `begin_encounter` choke point, after the pure checks, before the first DB read

`crate::guards::require_subject_not_deleting(ctx, "begin_encounter", player_identity)?;` — one fully
qualified, `?`-propagated statement (the ADR-0227 D2 call shape) after the pure `check_party_size` cap and
the pure duplicate-id scan, immediately before `is_in_ongoing_battle` (the first DB read) and every write
(ADR-0236 D2's "first stateful check" rule, verbatim). `begin_encounter` is the function both openers share
— `movement_tick` (the scheduler) and the dev-only `start_wild_battle` — and it is where the `battle` row is
actually built, so gating it closes the class at function granularity, which is what ADR-0236 admitted its
reducer-granularity claim did not. `start_wild_battle` double-gates harmlessly: its own caller gate fires
first, and the identity it passes IS `ctx.sender()`. The subject is the server-derived `player_identity`
(bound from the character's own `player` row), never `ctx.sender()`, which is the module identity on the
scheduler path.

### D4 — The reject log records the SUBJECT, not the sender; the envelope drift is recorded here

`log_reject(reducer, subject, e)`. On the scheduler path `ctx.sender()` is the database identity, so logging
it would make every grass refusal indistinguishable and leave the operator with no record of WHICH walker
was refused. The reject envelope's field is still spelled `sender` (renaming it is an observability-slice
change gated by `evals/observability-log-wrapper`), so at this one site the field carries a non-sender —
the same kind of recorded semantic drift ADR-0237 D3 accepted for its reason text. From `start_wild_battle`
the subject IS the sender, so the drift materialises only on the scheduler path. The reason stays the single
static, PII-free constant; the identity is the only variable field, as in every other reject line.

### D5 — `movement_tick` treats the refusal as ROUTINE: a skip above the limiter, spelled the only way the ADR-0170 D4 pin admits

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
character's failure must never abort the zone tick, ADR-0066). No account vocabulary enters `movement.rs`:
the reason constant is the only thing it learns, and it is pinned to exactly one mention there.

### D6 — Enforcement vehicle: execution first, equality pins for what execution cannot see, a census for containment

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
  `starts_with` pins admitted trailing-combinator and `cfg!`-keyed mutants); on `begin_encounter`: the
  qualified statement with its argument exactly once on the string-blanked view, the tag exactly once on the
  strings-intact view (the only witness for a wrong tag — the rb-46 census pins tags for the four
  `#[spacetimedb::reducer]` names only), PREFIX EQUALITY of everything above the gate (the sole defence
  against the whole above-the-gate class: the two early-return twins rb-46 measured and the `macro_rules!`
  residual ADR-0236 disclosed), a body-wide `#[` / `cfg!(` ban, the bare name once in the body, and the
  anchors `check_party_size(` < gate < `is_in_ongoing_battle(ctx,player_identity)` < `battle().insert(`;
  on `movement_tick`: the skip and the existing filter as one contiguous squashed sequence.
- **Census** — the crate-wide single-consumer census of D2, derived from `lib.rs`, with the same three
  anti-vacuity clauses as rb-47's (guards.rs count exactly one, ≥10 modules derived, the six two-player
  modules plus `movement` present, an unreadable module panics by name).

The proof-of-teeth mutant register is executed one mutant at a time by a runner in the acceptance ledger
(`memory/projects/gates/rb-76.*`), never in this ADR body.

### D7 — Anti-decisions (restated so the successor does not re-open them)

No gate in `movement_tick` (D3's rejected alternative); no second consumer of the new seam anywhere; no
bool-returning identity oracle exported from `guards.rs`; no new reason constant; no runtime "scope"
precondition (below); `submit_pvp_action` and every in-flight reducer stay ungated (ADR-0227 D5, ADR-0236
D5); `require_not_deleting`'s signature and body stay byte-identical.

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
  would have to be discarded with `.is_err()`, and it keys the gate on the CALL PATH rather than on what is
  created — `begin_encounter` would stay an ungated opener for any future caller. Gating both — rejected:
  all of that cost, no additional security, and it breaks the single-consumer census.
- **Treat the encounter as world simulation and leave it open** — rejected (D1).
- **Log the sender** — rejected (D4).

## Consequences and residuals

- The gated set of §4.7 openers now closes at FUNCTION granularity in `battle.rs`: `start_battle`,
  `start_wild_battle` (caller-only wrapper, rb-46) and `begin_encounter` (subject wrapper, this ADR).
  `guards.rs` gains its first identity-parameterised wrapper; ARCHITECTURE.md's guards row and the deletion
  paragraph are updated; ADR-0236's GRASSPATH residual is discharged by a dated amendment there.
- A mid-grace or terminal walker keeps walking, keeps drawing an encounter roll per grass step, and is
  refused only when a roll would have opened a battle — by design (D1), not a residual. Each refusal is one
  `log_reject` warn line, bounded by the encounter rate per walker, the same envelope as every other gated
  site.
- **Residual (backlog, R-rb-76-ENVELOPE):** the reject envelope's `sender` field carries the SUBJECT at this
  one site (D4). Closing it needs either a renamed/added field in the log wrapper or a subject-aware
  `log_reject` sibling, both gated by `evals/observability-log-wrapper` and outside this slice's touches.
- R-rb-46-ERASEWRITERS (the other ERASE-policy writers — `heal_party`, `advance_dialogue`, the taming
  `grant_item` path) is unchanged by this ADR.
- Known limits, recorded honestly: the census cannot see a `#[path]`-relocated consumer (the derivation
  panics on an unreadable module rather than skipping it, which is the honest failure); the native host's
  fixed all-zero sender means "reject every real client" would be a total outage visible to the first e2e,
  not a privacy defect; the prefix-equality literal must be re-derived deliberately whenever a legitimate
  pure check is added above the gate.

## Confirmation

`just ci-fast monster-realm-module` runs the six `rb76_` tests (`guards_tests.rs`: the wrapper
declaration/equality pin, the crate-wide single-consumer census, the executed wrapper matrix;
`battle_tests.rs`: the executed five-state walker progression with the sender-vs-subject controls, the
`begin_encounter` source pin; `movement_tests.rs`: the routine-skip contiguity pin), all inside `just ci`.
The ledger CHECK for the seeded criterion is the filtered `cargo nextest` run with the passed count pinned.
