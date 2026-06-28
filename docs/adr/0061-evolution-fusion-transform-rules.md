# 0061. Evolution & fusion transform rules: eligibility resolver, individuality carry, fusion combine

- Status: accepted
- Date: 2026-06-28
- Milestone: M10a-rules (evolution & fusion — the pure rule layer; delegated to by M10b reducers)

> **ADR numbering / authority note.** The design corpus records the *model* decision
> in the **harness** as **ADR-0019** ("evolution & fusion model — individuality-preserving").
> ADR-0060 (project) recorded the *content shape* (the `EvolutionTrigger`/`FusionRecipe`
> registries + the integrity validator). This ADR records the *transform rules* — the
> edge semantics ADR-0019 left open and that M10a-rules must pin so M10b reducers and
> later milestones consume one stable rule SSOT. Like ADR-0060, this is a **realization**
> ADR under corpus ADR-0019 (the model authority), not a peer to it. The next-free
> project number is **0061** (see ADR-0057/0060's divergence note).

## Context and problem statement

M10a-rules adds the pure `game-core/src/evolution/` module: the deterministic
**eligibility** check and the **evolve** / **fuse** transforms that M10b's server
reducers delegate to. The module imports the M10a-content types (`EvolutionTrigger`,
`EvolutionCondition`, `SpeciesEvolutions`, `FusionRecipe`, `Species`) and reuses
`derive_stats` (the M6 SSOT). ADR-0019 fixes the load-bearing principle — **carry/combine
individuality, never re-roll** — and the §3 EARS criteria fix the headline rules
(per-stat max IV; higher-bond nature; fresh level 1; lower party slot; re-derive on
evolve). But several **edge semantics are left open**, and each is a deterministic rule
that M10b and the property tests must pin precisely:

1. How to model `evolves_to` for both the *passive* (server stores it on the row) and
   the *item-triggered* paths without two divergent functions.
2. The branch-priority tie-break when a monster satisfies **two** evolution branches.
3. Inclusive vs exclusive level/bond thresholds; whether an `Item` trigger ever fires
   passively.
4. `current_hp` after evolution (the spec says "re-derive stats" but is silent on HP).
5. The offspring's **bond** after fusion (the spec lists "fresh: level 1, no EVs, no
   nickname" but is silent on bond), the **nature tie-break** when both parents' bonds
   are equal, the **party-slot** combine for the asymmetric (in-party, in-box) case,
   `current_hp`, and `xp`.

Leaving these to implementer discretion is exactly the "integrity by author discipline"
failure ADR-0019 rejected. They are recorded here as mechanical, tested rules.

## Decision outcome

### 1. Eligibility — one resolver with an `applied_item` seam

```rust
pub fn resolve_evolution(
    evolutions: &[EvolutionCondition], // the matching species' branch list
    level: Level, bond: Bond, applied_item: Option<u32>,
) -> Option<u32>                       // the to_species of the first matching branch
pub fn evolves_to(evolutions: &[EvolutionCondition], monster: &MonsterInstance) -> Option<u32>
    // == resolve_evolution(evolutions, monster.level, monster.bond, None)
```

- **One resolver, two entry points.** `applied_item == None` is *passive* eligibility —
  the value M10b stores on the monster row and shows the client. `applied_item == Some(id)`
  is the *item-use* path the `evolve` reducer calls when an item is applied. A single
  function with the `Option<u32>` seam serves both — no second function, no divergence.
  `evolves_to` is the thin `&MonsterInstance` convenience M10b uses for the stored column;
  `resolve_evolution(.., Some(item))` is the item-triggered path. **M10b contract:** use
  `evolves_to` for the row column; `resolve_evolution(.., Some(item))` at item-use time.
- **Trigger semantics (inclusive thresholds):** `Level(l)` fires when `monster.level >= l`;
  `Bond(b)` fires when `monster.bond >= b`; `Item(id)` fires **only** when
  `applied_item == Some(id)`. An `Item` branch therefore **never** fires on a passive
  (`None`) check — passive eligibility is level/bond only. The per-branch predicate
  `match`es `EvolutionTrigger` with **no wildcard arm**, so a future 4th variant
  compiler-flags here (the deliberate non-`non_exhaustive` / OCP-inversion of ADR-0060).
- **Branch-priority tie-break: the FIRST matching branch in declaration (RON) order.**
  When a monster satisfies more than one branch (e.g. both `Level(16)` and `Bond(200)`),
  the earlier-declared branch wins. This is total, deterministic, and content-authorable
  (the author orders branches by priority). It is **not** the v1 "first matching *recipe*
  by row order" anti-pattern ADR-0019 rejected — that was *ambiguous fusion recipes*
  (two recipes for one pair, fixed by the order-independent dedup validator). Evolution
  branch priority is a legitimate, intended, single-registry ordering. A "collect all" or
  iteration-order-dependent resolver is the anti-pattern here.

### 2. `evolve` — carry individuality, re-derive, clamp HP

```rust
pub fn evolve(monster: &MonsterInstance, to_species: &Species) -> MonsterInstance
```

- **Carries verbatim** (no re-roll — ADR-0019): `nickname`, `level`, `xp`, `ivs`, `nature`,
  `evs`, `bond`, `party_slot`. Sets `species_id = to_species.id`. Re-derives via
  `derive_stats(&to_species.base_stats, &monster.ivs, &monster.evs, &monster.nature,
  monster.level)` — the SSOT, never re-implemented.
- **`current_hp` = `monster.current_hp.min(new_derived.hp)`** (clamp to the new max).
  Evolution is a *transformation, not a heal* — carry the damage. The `min` makes the
  function **total**: it upholds the cross-cutting invariant `current_hp <= derived.hp`
  even for a content target whose base HP is *lower* than the source's (a legal content
  shape — nothing in the types forbids a lower-HP evolution). Verbatim-carry would break
  the invariant in that case; full-heal would silently reward evolving. For the common
  higher-HP target the `min` is a no-op carry.

### 3. `fuse` — combine individuality, fresh body

```rust
pub fn fuse(a: &MonsterInstance, b: &MonsterInstance, offspring: &Species) -> MonsterInstance
```

- **IVs: per-stat `max`.** `IVs::new(iv(Hp), iv(Attack), …)` where
  `iv = |k| a.ivs.get(k).max(b.ivs.get(k))` — a single `|k|` closure (mirrors `evs_with`
  in `raising/rules.rs`) so a field transposition is impossible. Infallible: the max of two
  values each `<= 31` is `<= 31`, so `IVs::new` cannot reject — `.expect("per-stat max of
  two <=31 IVs is <=31 by construction")` (the `level_for_xp().unwrap()` / `focus_train`
  `.expect` precedent), not a `Result` that pushes an unreachable error onto callers.
- **Nature: the higher-bond parent's; tie → `a`.** `if a.bond >= b.bond { a.nature } else
  { b.nature }`. The `>=` resolves the equal-bond tie to the first argument.
- **Bond: `Bond::default_bond()` (70).** A fused offspring is a **new individual / new
  relationship** — "fresh" in the same sense as its fresh level/EVs/nickname, and the same
  value every freshly-built monster gets (`build_monster`, `monster/rolls.rs`). Carrying a
  parent's accumulated bond would import a relationship the player never built with *this*
  creature and add a second order-dependent field. (The spec lists "fresh: level 1, no EVs,
  no nickname"; bond is part of that freshness, recorded here because the spec is silent.)
- **`party_slot`: the minimum *present* slot, else `None`.**
  `[a.party_slot, b.party_slot].into_iter().flatten().min()`. So `(Some, None)` →
  `Some` (an active parent keeps the offspring active — "fusion never silently shrinks the
  team"), `(Some(x), Some(y))` → `Some(min)`, `(None, None)` → `None`. **Trap avoided:** a
  raw `Option::min` is wrong (`Ord` puts `None < Some(0)`, so it would box an offspring of
  an active parent); `.or()` is wrong (asymmetric on two `Some`s).
- **Fresh body:** `level = 1`, `evs = EVs::zero()`, `nickname = None`,
  `xp = xp_for_level(L1)` (the `build_monster` convention — the start of the level band, so
  `level_for_xp(xp)` round-trips to 1 — not a hardcoded `0`), `current_hp = derived.hp`
  (full, undamaged). `Level::new(1).expect("1 is a valid level")` is infallible.

### 4. Order-independence and the M10b canonicalization contract

`fuse(a, b, s)` is order-independent (`== fuse(b, a, s)`) for **every** field
*except* nature when the two bonds are **equal** (then the first argument's nature wins).
The pure layer cannot canonicalize — it has no monster identity to break the tie on.
**M10b contract (named downstream obligation):** before calling `fuse`, the reducer
**should canonicalize parent order** (e.g. ascending `monster_id`, or the recipe's
`(min, max)` species convention) so an equal-bond fusion is reproducible regardless of
which monster the player selected first.

### 5. Purity and guards

- **No RNG, no clock.** The *absence* of an injected RNG is precisely the
  individuality-preservation guarantee (ADR-0019): there is nothing to re-roll. An RNG
  parameter would be the bug, not a feature. Enforced mechanically by the workspace
  `clippy.toml` `disallowed-methods` purity gate.
- **Guards are M10b's job.** Ownership, eligibility, in-battle / in-trade escrow
  (ADR-0017/M7/M15) are **server reducer** obligations. The pure transforms trust a
  validated caller: `evolve`/`fuse` will transform any monster in any state. M10b MUST
  call `reject_if_in_battle`/`reject_if_in_trade` and verify ownership + eligibility/recipe
  before delegating here.

## Considered alternatives

- **Two eligibility functions (passive vs item)** — rejected: divergent logic, the bug
  ADR-0019 warns about; the `Option<u32>` seam unifies them.
- **`evolve` full-heal or verbatim `current_hp` carry** — rejected: full-heal rewards
  evolving; verbatim-carry breaks `current_hp <= max` for a lower-HP target. Clamp is total.
- **Fusion offspring inherits the higher parent's bond** — rejected: imports an unearned
  relationship and adds a second order-dependent field; `default_bond` matches every other
  fresh monster.
- **`fuse`/inner ctors return `Result`** — rejected: the errors are unreachable by
  construction; `.expect` with a proof comment is the codebase precedent.

## Consequences

- **Positive:** one resolver serves both eligibility paths; every transform edge is a
  mechanical, property-tested rule (not author discipline); `derive_stats` stays the lone
  stat SSOT; the no-wildcard `match` compiler-flags a future trigger variant; purity is
  clippy-enforced; `current_hp <= max` and "valid `MonsterInstance`" are invariants the
  property tests pin.
- **Negative / accepted:** `fuse` nature is order-sensitive under equal bonds (the named
  M10b canonicalization contract, §4); the bond-reset and HP policies diverge from a naive
  reading of the spec and are recorded here; this slice is **fan-out-ineligible** — it owns
  the rule SSOT and the `lib.rs` evolution re-exports, so any concurrent sibling editing
  those collides. It runs solo.
- **References:** corpus ADR-0019 (model authority), ADR-0060 (content shape this layer
  consumes), ADR-0006 (content-is-data), ADR-0010 (proof-of-teeth), ADR-0003 (SSOT /
  determinism / purity). The unchanged `derive_stats` + the clippy purity gate are the
  existing mechanisms this builds on.
