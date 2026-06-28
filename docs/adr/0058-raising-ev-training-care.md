# 0058. Raising rules — EV focus-training (top-off) and care (bond), as pure-core invariants

- Status: accepted
- Date: 2026-06-28
- Milestone: M9a (game-core/raising — critical-path start of M9 raising)

> **ADR numbering note.** Supervisor-assigned `0058` — the next free project-local
> implementation-ADR number after `0057` (content-directory glob loading). The M9
> spec (`specs/monster-realm-v2/M9-raising.spec.md`) lives in the harness corpus and
> references the *design* ADRs `0006`/`0010`/`0015`/`0016`/`0018`; this ADR records
> the *implementation* decision for the pure rule layer. `docs/adr/README.md` (the
> index) is owned by the supervisor and is intentionally not touched by this slice.

## Context and problem statement

M9 ("raising") lets a player grow a monster through two deliberate, validated actions:
**focus-training** (spend a training food to nudge a stat via EVs) and **care** (raise
bond). Slice **M9a** builds *only* the pure, deterministic rule layer in
`game-core/src/raising/`; the server reducers (`train`/`care`, ownership + the care
cooldown from `ctx.timestamp`) and the item backbone are **M9b**, which *delegates to
these rules*. The client UI is M9c and the privacy/security evals are M9d.

The rules must honor the established spine:

- **SSOT (ADR-0003 / ADR-0016 derive-on-write):** the stat formula lives **once**, in
  `game-core::monster::rules::derive_stats`. Training changes EVs, so it MUST re-run
  `derive_stats` and re-store `derived_stats` — never fork or inline the formula, and
  never recompute stats on the client.
- **Reject-not-clamp + illegal-states-unrepresentable (the M8.5/ADR-0049 family):** the
  M9 spec §3 draws the reject/clamp line precisely — *"a near-cap food tops off; a maxed
  stat doesn't eat the item for nothing."* A maxed target stat (or an exhausted total-EV
  budget) must return `Err` so the M9b reducer rejects the action and does **not** consume
  the food / burn the cooldown.
- **Determinism (ADR-0003):** no clock, no RNG, no I/O. The care *cooldown* time is read
  from `ctx.timestamp` in the M9b reducer — never in the rule.
- **Additive — no new state shape.** M6 already reserved the fields on `MonsterInstance`
  (`evs: EVs`, `bond: Bond`, `derived_stats: StatBlock`) with their caps enforced at
  construction (`EVs::new` rejects per-stat > 252 / total > 510; `Bond` is full `u8`
  range). M9a therefore adds **no** field and does **not** edit `monster/types.rs`.

The open question this ADR settles: the exact **rule signatures, the top-off arithmetic,
the reject-vs-clamp error model (and its precedence), the bond cap, and the `current_hp`
boundary** — so M9b builds against a fixed, tested contract.

## Decision outcome

### 1. A new `game-core/src/raising/` module with two pure functions

`raising/` is a peer sub-domain alongside `monster/`, `combat/`, `taming/`, with the same
shape (`mod.rs` + `rules.rs` + `types.rs` + a `#[cfg(test)] m9a_gating_tests.rs`). `lib.rs`
gains `pub mod raising;` and a re-export block. The two functions take **individual,
all-distinct-typed positional params** (mirroring `derive_stats`' 5-positional signature —
so a mis-ordered argument is a compile error), not `&mut MonsterInstance`:

```rust
pub fn focus_train(
    base: &StatBlock, ivs: &IVs, evs: &EVs, nature: &Nature, level: Level,
    target: StatKind, amount: u16,
) -> Result<FocusTrainResult, FocusTrainError>;

pub struct FocusTrainResult { pub evs: EVs, pub derived_stats: StatBlock }

pub fn apply_care(bond: Bond, amount: u8) -> Result<Bond, CareError>;
```

**Return the *changed values*, not the aggregate.** `focus_train` returns the new `EVs`
**and** the re-derived `StatBlock` (a named 2-field struct, not a bare tuple, so call sites
read `r.evs` / `r.derived_stats`). The M9b reducer does the single write-back
(`MonsterInstance { evs: r.evs, derived_stats: r.derived_stats, ..old }`). Returning
`derived_stats` *from inside the core* means the re-derive happens where `derive_stats` is
already imported and proven — M9b **cannot** forget to re-derive or call it with stale EVs.
`base` is injected (M9b reads `species.base_stats` by `species_id`, exactly as
`monster::rolls::build_monster` does) because base stats live on `Species`, not the instance.

### 2. Focus-training top-off arithmetic + a fail-loud-but-graceful error model

The grant is bounded by **both** caps simultaneously:
`grant = min(amount, EV_PER_STAT_CAP − cur, EV_TOTAL_CAP − total)` (252 / 510). The
function is structured as **ordered guard clauses** so every rejection yields a *precise*
variant and the happy path is provably non-degenerate:

```text
1. if amount == 0                  -> Err(NoEffect)        // input/contract error
2. else if cur   == 252            -> Err(StatAtCap)       // per-stat headroom = 0
3. else if total == 510            -> Err(BudgetExhausted) // global headroom = 0  (cur < 252 here)
4. else grant = min(amount, 252-cur, 510-total)   // >= 1 by construction
        new_evs  = evs_with(target, cur + grant)  // <= 252 per-stat, <= 510 total -> EVs::new Ok
        derived  = derive_stats(base, ivs, &new_evs, nature, level)
        Ok(FocusTrainResult { evs: new_evs, derived_stats: derived })
```

```rust
pub enum FocusTrainError { StatAtCap, BudgetExhausted, NoEffect }   // Debug,Clone,Copy,PartialEq,Eq
pub enum CareError       { AtMaxBond, NoEffect }
```

Three decisions are load-bearing here:

- **Guards before arithmetic ⇒ no underflow, no `grant == 0` happy path.** Because the
  `cur == 252` and `total == 510` guards return *before* the subtractions, `252 − cur ≥ 1`
  and `510 − total ≥ 1` whenever they execute, and with `amount ≥ 1` the grant is **always
  ≥ 1**. A successful `Ok` therefore *always* moves at least one EV — the reject-not-clamp
  invariant generalizes to **reject-not-no-op**.
- **`EVs::new(...).expect("top-off stays within EV caps by construction")` is genuinely
  unreachable.** `new_cur = cur + grant ≤ cur + (252 − cur) = 252` and `new_total = total +
  grant ≤ total + (510 − total) = 510`, so the validating constructor cannot reject. The new
  `EVs` is built via a private `evs_with(evs, target, new_val)` helper that reads each of the
  six `StatKind`s and substitutes **only** the target — so a field-swap/double-write bug
  cannot silently corrupt a sibling stat (a near-cap fixture, `total = 508 + grant 2 → 510`,
  is pinned so such a bug *panics in the suite*, not in production). This uses the codebase's
  proven-invariant idiom (`IVs::new(...).expect(...)` in `rolls.rs`).
- **Error precedence: input-validity (`NoEffect`) first, then state (caps) — uniformly in
  both rules.** When `amount == 0` co-occurs with a maxed stat/bond, `NoEffect` wins. This is
  standard guard-clause discipline (validate arguments before inspecting state) and gives the
  *same* ordering in `focus_train` and `apply_care` (least-surprise). `amount == 0` is a
  **content-config contract violation** (a training food / care action that grants nothing) —
  surfacing it first tells content authors their data is broken independent of which monster
  it targets. `StatAtCap` deliberately wins over `BudgetExhausted` when both are true (a
  capped stat is the more specific, stable condition). The error is returned (not
  `debug_assert!`-panicked) so a content typo is a clean reject in release, not a crash.

### 3. Care: saturating bond raise, reject at max; bond cap = full `u8` range

`apply_care`: guard `amount == 0 → Err(NoEffect)`, then `bond.value() == u8::MAX →
Err(AtMaxBond)` (the M9 spec's "reject at max bond *before* burning the cooldown" — the M9b
reducer gets this as `Err(AtMaxBond)` and rejects before touching `last_care_at_ms`), else
`Bond::new(bond.value().saturating_add(amount))`. **Saturating, never wrapping** (the bond
analog of `derive_stats`' u16-saturation teeth). The bond maximum is **255 = `u8::MAX`**,
the full representable range of the M6 `Bond(u8)` type — there is **no** separate bond-cap
field (M9a does not touch `types.rs`) and **no public `BOND_MAX` constant** (YAGNI: no
consumer needs it — M9b learns "at max" from `Err(AtMaxBond)`, and tests use `u8::MAX`).

### 4. SSOT re-derive — `focus_train` calls `derive_stats`, never forks it

The re-derived `StatBlock` is produced by the existing `derive_stats(base, ivs, &new_evs,
nature, level)`. A property test asserts `r.derived_stats == derive_stats(base, ivs,
&r.evs, nature, level)` over the full valid domain, so **any** forked/inlined formula
diverges and fails. Exact-value known-answers pin the numbers where a fork could hide:
training the nature-*raised* stat (Adamant + Attack, EV crossing the `/4` boundary) and
training **HP** with a non-neutral nature (HP must stay nature-independent).

### 5. `current_hp` re-clamp/heal is deferred to M9b — and that deferral is *safe*

`focus_train` returns `evs` + `derived_stats` and deliberately does **not** touch
`current_hp`. Adding HP EVs can only *raise* HP at a fixed level (the `+ ev/4` term is
monotonic non-decreasing), so for any monster `current_hp ≤ old_max_hp ≤ new_max_hp` — the
"current ≤ max" invariant is preserved with no work. No illegal/corrupt state is
representable by the deferral. **M9b owns the write-back policy** (write `derived_stats`;
whether training also *heals* the monster to the new max is a gameplay call M9b/M9-review
decides). A teeth case asserts HP is non-decreasing after HP training, documenting the
safety invariant in the suite. `focus_train` stays `pub` (M9b is a separate crate).

## Considered alternatives

- **`&mut MonsterInstance` in the core** — rejected: leaks the imperative shell into the
  functional core, forces every property test to build a full 11-field instance to vary 2
  inputs, and couples the rule to fields it never reads (`xp`, `party_slot`, …). The
  returned-changed-values shape keeps the core a pure `inputs -> Result<outputs>` transform
  (ADR-0003 functional-core/imperative-shell).
- **Return the whole updated `MonsterInstance`** — rejected (YAGNI + wider coupling): would
  copy/own unchanged fields and re-assert their invariance; the reducer already holds the row
  and does a struct-update.
- **Clamp-and-succeed at a maxed stat / bond (Postel *not* inverted)** — rejected: the M9
  spec mandates reject so the reducer doesn't consume the food / burn the cooldown for
  nothing. Silent clamp hides the condition and wastes the player's item (the harm the rule
  exists to prevent).
- **Treat `amount == 0` as a `debug_assert!` precondition** (the recruit-chance precedent) —
  rejected here: `amount` is **data-driven content** (the training-food / care item def), and
  a content typo of `0` should be a clean *reject* at the trust boundary, not a release-mode
  silent success nor a debug-only panic. Modeled as the value-error `NoEffect`.
- **`AtMaxBond` before `NoEffect` in `apply_care`** (the red-team's state-first reading) —
  considered and rejected for **module-wide precedence uniformity**: both rules check
  argument-validity (`NoEffect`) before state (caps). Functionally both still reject before
  the cooldown; the choice only affects which message a (content-bug-only) co-occurrence
  yields, so consistency wins.
- **A public `BOND_MAX` constant** (the plan's first cut) — rejected (YAGNI / SSOT-split): no
  consumer; `u8::MAX` is the obvious bound and `Err(AtMaxBond)` carries the signal M9b needs.
- **Adding `EVs::add_capped` / `Bond::raise` to `monster/types.rs`** — rejected: outside this
  slice's `touches:` (the supervisor owns that file). The rule composes the existing
  `EVs::new` / `Bond::new` constructors via the `evs_with` helper.

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

Each must **fail a realistic wrong impl** and assert the **exact `Err` variant / exact
value**, never just `is_err()` / a delta:

- **Per-stat & total caps never exceeded:** `cur=250, amount=10 → cur'=252` (not 260);
  `total=508, cur=0, amount=2 → Ok, total'=510` (catches a budget-ignoring impl that would
  panic the `.expect`); the budget-headroom fixture `cur=100, total=509, amount=100 → grant 1,
  cur'=101, total'=510` (a per-stat-only impl produces total 609 → `EVs::new` Err → panic).
- **Top-off exact-to-cap, not off-by-one:** `cur=251, amount=5 → 252` (not 251, not 256).
- **Reject-not-clamp, exact variant:** `cur=252, amount=1 → StatAtCap`; `cur=0, total=510,
  amount=1 → BudgetExhausted`; `amount=0 → NoEffect`; precedence `cur=252, amount=0 →
  NoEffect`; `apply_care(255,5) → AtMaxBond`; `apply_care(50,0) → NoEffect`; `apply_care(255,0)
  → NoEffect`.
- **Non-target EVs unchanged:** training Attack leaves all five other EVs equal.
- **SSOT:** proptest `r.derived_stats == derive_stats(base, ivs, &r.evs, nature, level)` over
  the domain; exact-value Adamant+Attack (EV crosses `/4`) and HP-target-nature-ignored.
- **Care saturates not wraps:** `254+2 → 255`, `200+u8::MAX → 255`.
- **Determinism:** `focus_train(x) == focus_train(x)`, `apply_care(y) == apply_care(y)`.
- **Totality:** proptest `focus_train` never panics for any `(evs, target, amount ∈ 0..=u16::MAX)`;
  branch-classification proptest mirrors the pinned guard order.
- **HP-deferral safety:** HP is non-decreasing after HP training (documents §5).

## Consequences

- **Positive:** M9b builds against a fixed, tested rule contract; the stat formula stays
  single-source (a fork can't compile-pass the SSOT proptest); the item economy can never be
  cheated past the EV caps; reject-not-clamp keeps training honest (no food consumed for
  nothing); zero new schema/state shape.
- **Accepted residuals (recorded, not fixed here):**
  - **(a) `current_hp` heal-on-train policy** is M9b's call (§5) — safe to defer (HP only
    rises; `current ≤ max` holds).
  - **(b) The care *cooldown*** (per-monster, from `ctx.timestamp`) and **ownership/owned-item
    validation** are M9b (server-authoritative; the rule is time/identity-free by design).
  - **(c) `amount` / cap **tuning** (per-food EV grant, care bond step)** is data-driven
    content the M9b reducer supplies — the rule takes them as params.
- **References:** ADR-0003 (rule SSOT / functional core), ADR-0016 (derive-on-write),
  ADR-0015 (owner RLS — M9b), ADR-0018 (item model — M9b), ADR-0049 (reject-not-clamp /
  fail-loud family), ADR-0053 (pure-core-invariant precedent — same module-shape & teeth
  discipline).
- **Follow-ups:** M9b (`player_item` backbone + `train`/`care` reducers delegating to
  `focus_train`/`apply_care`, cooldown, ownership, re-derive write-back + current_hp policy);
  M9c (inventory/raising UI); M9d (privacy + reducer-security evals).
