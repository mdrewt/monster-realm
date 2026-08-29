# 0210 — The sanctioned-reducer pin becomes a status ledger: a pre-declared reducer is admitted, an undeclared one is not

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-6 (residual R-m22-s1-X1)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz
**Decision:** `[R/name-set]`'s flat five-name array becomes a frozen ledger with a closed `REQUIRED`/`PLANNED` status, so a pre-declared reducer is admitted while `[R/sanction-shape]` and `[R/planned-set]` keep every unsanctioned one red.

---

## Context and problem statement

`[R/name-set]` pinned the reducer surface of `server-module/src/accounts.rs` by **exact sorted
set equality** against five names. That strictness is deliberate and load-bearing: both proven
takeover PoCs documented in the eval's header are **additive** reducers, and one of them —
FG15's `adopt_guest_by_code`, a wire-safe `String` parameter that reads an existing claim row and
calls `rekey_all` — declares no `Identity` parameter and constructs no `Identity`, so
`[R/param-types]` and `[R/identity-ctor]` are both green on it. `[R/name-set]` is the **only**
clause that catches it. Losing exactness there loses the gate.

But exactness has a scheduling cost the corpus already paid for. `game_core::STATE_TRANSITION_OWNERS`
(`game-core/src/accounts/deletion.rs:113-117`, shipped by M22 S1) names `account_deletion_reaper`,
and ADR-0207 D5 requires M22 S3 to land `AccountDeletionReaperSchedule` **atomically** with that
reducer — SpacetimeDB lists "changing whether a table is used for scheduling" as a Forbidden
Change, so the table cannot precede the reducer. The moment S3 declares it, `[R/name-set]` hard-REDs
on a **legitimate, pre-declared, ADR-approved** reducer. S3 cannot fix it: this eval is outside
S3's `touches:`. The residual (R-m22-s1-X1) sat 4.5 days for exactly this reason.

So the requirement is narrow and two-sided: admit a reducer that has been **declared in advance,
consciously, in this file**, and keep hard-REDing everything else.

## Considered alternatives

- **A — Relax to containment / `>= 5`.** Rejected outright: this is the exact shape the original
  pin exists to refuse. Both PoCs and FG15 are green under it.

- **B — Just add a sixth name to the flat array.** Not available. The comparison is set *equality*,
  so a six-name array **false-REDs on today's five-reducer tree**. Some notion of
  permitted-when-present is structurally required.

- **C — Derive the permitted extensions by parsing `game_core::STATE_TRANSITION_OWNERS` out of
  `game-core/src/accounts/deletion.rs`.** Attractive on the surface — it grounds the word
  "sanctioned" in a cross-crate SSOT that `deletion_tests.rs:384-410` independently pins to exactly
  three spec names. **Rejected on two measured grounds.**
  1. It is the *wrong* anti-forgery tooth. `STATE_TRANSITION_OWNERS` is owned by a different crate
     and a different slice; a future M22 edit that legitimately adds a fourth name would silently
     widen **this** gate with zero diff in this file. That is precisely the property the pin exists
     to deny.
  2. The parse itself is hostile. The shared `stripRustSource` blanks string-literal *payloads*
     while preserving offsets, so the names must be read from RAW at offsets located in STRIPPED.
     Red-teaming that specification found two letter-compliant readings, and measured that the
     plausible-wrong one (re-scanning the raw span for quotes, rather than reusing the stripped
     quote offsets) resurrects a commented-out `/* "phantom_reducer", */` entry *inside* the array
     span as a fourth sanctioned name — poisoning the SSOT the clause exists to consult. A second
     bespoke Rust scanner beside the shared hardened `rust-scan.mjs` is also the exact duplication
     ADR-0181 retired.
  Cut, not deferred: nothing is left undone. The cross-crate coherence-drift property it would have
  added is a records-are-not-queues problem the residual sink (`M-residual-backlog.spec.md`) already
  owns end-to-end.

- **D — A status ledger with a closed discriminator (chosen).** See below.

## Decision outcome

**Chosen: D.** `SANCTIONED_REDUCERS` becomes `REDUCER_SANCTIONS`, a deeply frozen object keyed by
reducer name whose values carry an explicit `status` and a `why`:

- `REQUIRED` — shipped today; **must** be found in `accounts.rs`. A missing one is a client entry
  point that silently disappeared.
- `PLANNED` — declared in advance and pre-reviewed here; **permitted when present**, not required.
  Exactly one entry: `account_deletion_reaper` (M22 S3, ADR-0207 D5).

Three clauses, each with a distinct job:

1. **`[R/sanction-shape]`** — runs FIRST and fails closed. Every ledger value must be an
   own-property object whose `status` is EXACTLY one of the closed set `{REQUIRED, PLANNED}`, with
   that kind's closed field set. The discriminator is read once, by one function, and never
   inferred from `typeof` or needle presence — the same rule ADR-0208 established for
   `[G6/policy]`.
2. **`[R/name-set]`** — (a) every reducer found in `accounts.rs` must be an **own** key of the
   ledger; (b) every `REQUIRED` key must be found. Both halves are load-bearing: (a) is FG15's
   killer, (b) is FG16's.
3. **`[R/planned-set]`** — the sorted `PLANNED` key set equals EXACTLY
   `['account_deletion_reaper']`, in both directions, by the same sorted-equality device the
   original pin used. Widening the permissive category therefore still requires a conscious,
   separately-spelled diff **in this file**, reviewed here — which is the property ADR-0179 G2
   actually cared about.

### Why `[R/sanction-shape]` is not optional

Without it, the design is **worse than what it replaces**, and this was measured rather than
argued. A faithful implementation of membership-plus-required-presence *without* a closed
discriminator was written and driven against every fixture in the design (25/25 assertions
passing, delegating every other clause to the real unmodified `checkNoClientIdentity`). A ledger
entry with a **third** status string is then admitted by (a) — it is an own key; never demanded by
(b) — it is not `REQUIRED`; and invisible to `[R/planned-set]` — it is not `PLANNED`. It is a free,
silent, optional whitelist slot. With

```js
migrate_legacy_account: { status: 'LEGACY', why: 'kept for back-compat, not client-facing' }
```

in the ledger and

```rust
#[spacetimedb::reducer]
pub fn migrate_legacy_account(ctx: &ReducerContext, legacy_code: String) -> Result<(), String> {
    let claim = ctx.db.guest_claim().code().find(&legacy_code).ok_or("no")?;
    rekey_all(ctx, claim.guest_identity, ctx.sender())
}
```

in `accounts.rs`, the pre-fix gate REDs and the discriminator-less ledger returns **PASS**. The
old flat array could not express "optional" at all; a heterogeneous `status` field can, and a
reviewer skimming five `REQUIRED` rows reads a sixth categorically-different row as less alarming,
not more. Fixture FG74g is that exact bypass, and it uses a third status string deliberately — not
one of the two the other fixtures exercise.

### `[R/planned-shape]`: a name is admitted because a SHAPE was reviewed

The first implementation of this decision was green under the full `just ci` (95/95 evals,
exit 0) and **still a measured weakening**. Red-teaming the shipped code found that
`[R/name-set]`'s membership test asks only whether a name is an own key of the ledger, and
nothing downstream re-checks that a reducer *called* `account_deletion_reaper` actually has the
scheduled shape that name was admitted for. `[R/param-types]`'s scheduled carve-out cannot cover
it, because that carve-out is reached only after `isWireSafeType(t)` **fails** — a wire-safe
impostor never arrives there. So:

```rust
#[spacetimedb::reducer]
pub fn account_deletion_reaper(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let claim = ctx.db.guest_claim().code().find(&code).ok_or("no")?;
    rekey_all(ctx, claim.guest_identity, ctx.sender())
}
```

— FG15's own `adopt_guest_by_code` body under a sanctioned name, with no scheduled table
anywhere — **passed the new gate and red the pre-fix one.** Measured, not hypothesised.

`[R/planned-shape]` closes it: a PLANNED name that is PRESENT must be a same-file
`scheduled(...)` target whose sole argument type IS the scheduled struct and whose body carries
the scheduler guard. The clause is deliberately narrow — the one PLANNED entry is a scheduled
reaper (ADR-0207 D5), and a future PLANNED entry of a different shape must extend this clause
consciously, which is the category's whole purpose. Fixtures FG74k (the measured impostor) and
FG74l (the zero-argument bare stub, which `[R/param-types]` is blind to because it iterates a
parameter list that is empty) pin both halves.

**The lesson is about the phrase "without weakening", not about this one clause.** A ledger that
admits by NAME is not the same gate as a pin that admits by exact SET, because the set pin had no
place to put a name whose shape was not simultaneously reviewed. Every relaxation of an exact pin
must be re-checked against the pre-fix gate on adversarial input, not only against its own
fixtures — which all passed.

### Proof of teeth (ADR-0010)

The residual's own criterion carries an **in-run RED control** rather than a one-time authoring
claim: FG74a builds the S3-shaped source (the `scheduled(...)` table, the reducer, the scheduler
guard), asserts the shipped classifier PASSes it, and in the same block recomputes the **pre-fix**
exact-set equality over the `REQUIRED` names against that same source and asserts it REDs. The
fixture can therefore never decay into a shape that would pass either way.

Because FG74a is assembled by concatenation onto `GOOD_ACCOUNTS`, `mut()`'s throw-on-missing
protection does not apply, so it additionally self-checks that six reducers actually parsed and
that the scheduler-guard needle is present in the text it built. This is not theoretical: a bare
zero-parameter stub named `account_deletion_reaper` was measured to yield the identical PASS
verdict, so without the self-check the fixture would prove less than its prose claims.

A mutation probe (`memory/projects/gates/rb-6.mutation-probe.mjs`) runs each of NINE wrong
implementations against a mkdtemp copy of `evals/` and pins the FG label per mutant — reverting
to exact-set equality (FG74a), deleting `[R/sanction-shape]` (FG74g), opening the status to a
third string (FG74g), deleting `[R/planned-set]` (FG74b), relaxing it to a one-sided subset
(FG74e), relaxing membership to `n in LEDGER` — the `Object.prototype` admission of a reducer
named `constructor` (FG74j), dropping the required-presence half (FG74f), deleting
`[R/planned-shape]` (FG74k), and waving through a zero-argument PLANNED reducer (FG74l). One
mutant was NARROWED rather than re-pointed when it was first caught by a neighbouring tooth: a
mutant that changes two things at once proves nothing about either.

An incidental but load-bearing constraint surfaced here and is recorded so the next author does
not rediscover it: **no NESTED template literal in a clause's message.** A brace matcher that
skips string spans — this repo's mutation probes, and `matchBrace` in several evals — resyncs on
the *inner* backtick and then counts a `}` that is really inside a string, ending the function
span early and producing a mutant that fails to parse rather than one that fails to bite. The
`[R/planned-shape]` message therefore binds `schedNote`/`guardNote` first.

### Consequences

- **Positive.** M22 S3 can ship `account_deletion_reaper` without touching this eval. The
  permissive category is bounded, named, justified in-file and separately pinned. The
  REQUIRED→PLANNED *demotion* attack — silently un-requiring a shipped entry point, which the old
  flat array had no way to express and therefore no way to catch — is now a fixture.
- **Negative.** One more concept in a file that is already dense, and a maintenance rule that is
  now three clauses instead of one. `PLANNED` is a genuine, if narrow, weakening for the single
  name it covers: `account_deletion_reaper`'s *disappearance* would not RED. It does not exist yet,
  so there is nothing to disappear; when S3 lands it, S3 should promote the entry to `REQUIRED`,
  which `[R/planned-set]`'s exact pin forces it to notice.
- **Follow-up (assigned, not deferred into prose).** `server-module/src/accounts_tests.rs:2057`
  `g2_reducer_name_set_is_pinned()` carries the identical exact-five pin in Rust and will ALSO
  hard-RED when S3 ships. It is outside rb-6's `touches:`. **rb-6 therefore removes one of two S3
  blockers.** The twin is assigned to **M22 S3**, whose `touches:` already include `accounts.rs`
  and whose co-located test file is in scope under ADR-0195 (rust-test-mirror parity); the twin's
  own panic message already instructs the author to update the pin consciously. S3 must **mirror
  the REQUIRED/PLANNED semantics**, not merely bump the count to six — a count bump re-creates the
  JS/Rust divergence ADR-0195 exists to prevent.
