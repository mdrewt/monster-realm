# 0060. Evolution/fusion content shape: a separate cross-referenced registry + additive validator

- Status: accepted
- Date: 2026-06-28
- Milestone: M10a-content (evolution & fusion — content + content-integrity half; gates M10a-rules)

> **ADR numbering note.** The design corpus records the *model* decision in the
> **harness** as **ADR-0019** ("evolution & fusion model — individuality-preserving +
> content integrity"). This project-side ADR records the *content-shape / realization*
> decisions that ADR-0019 left open and that the M10a-content slice's `touches:` boundary
> forced. Project `docs/adr/` numbering has diverged from the corpus (see ADR-0057's note);
> see `docs/adr/README.md` for the current next-free number. This file is the project-side
> SSOT; corpus ADR-0019 is the model authority it implements.
>
> **Spec-corpus crosswalk (for reviewers reading cold):** corpus ADR-0018 (inventory & item
> model) → project ADRs 0058–0059; corpus ADR-0019 (evolution & fusion model) → project
> ADRs 0060–0062.

## Context and problem statement

M10 adds branch **evolution** (a species evolves to a target species under level/item/bond
conditions) and **fusion** (an order-independent recipe `a + b → to`). M10a-content delivers
only the **shared content types** + the **seed content** + the **content-integrity
validators** (proof-of-teeth, ADR-0010). The **transforms/eligibility** are M10a-rules
(serial after this slice, importing these types); the **server table + `evolve`/`fuse`
reducers** are M10b.

The slice's declared `touches:` is **`game-core/src/content.rs` + `game-core/content/**`**
(plus a one-line `lib.rs` re-export and this ADR). Two facts about the *existing* code make
the spec's literal phrasings ("a `species.evolutions` field"; "extend `validate_content`")
impossible to honor without editing files **outside** that boundary:

1. **`Species` is built via literal struct constructors in code outside the boundary.** A new
   field on `Species` is an `E0063` ("missing field") at every literal `Species { … }` site.
   There are **8** such sites; **3 are outside `game-core/`** and therefore outside this
   slice — `server-module/src/{taming.rs:116, movement.rs:96, marshal_tests.rs:49}` (the
   other 5 are game-core test helpers, in-boundary but still churn). `#[serde(default)]` does
   **not** rescue this — it affects *deserialization*, never Rust struct-literal
   construction. So "evolutions as a `Species` field" cannot be additive within the boundary.

2. **`validate_content(species, skills, type_chart, items)` is a fixed public signature**
   consumed outside the boundary — `server-module/src/content.rs:106` (the server
   `sync_content` gate) plus ~10 game-core tests. Adding registries to its parameter list is a
   signature change that breaks the server call → outside touches.

3. **`build.rs` glob registries are a hardcoded list** (`["zones","species","skills","items",
   "encounters"]`, `build.rs:21`), and `build.rs` is outside the boundary. A *new* glob
   registry (`content/fusion/`, `content/evolutions/`) requires editing that list.

## Considered alternatives

- **(a) `Species.evolutions` field + extend `validate_content`** (spec's literal wording) —
  **rejected**: breaks 3 server-module literal constructors + the server `validate_content`
  caller (outside touches), and is not additive (E0063, not rescued by serde default). Would
  force a cross-slice edit the supervisor scoped *out* of M10a-content.
- **(b) Separate cross-referenced registries + a *new* sibling validator** — **chosen**.
  Evolutions become a `SpeciesEvolutions { species_id, evolutions: Vec<EvolutionCondition> }`
  registry keyed by `species_id`; fusion a `FusionRecipe { a, b, to }` registry; integrity
  lives in a new `validate_evolution_fusion(species, evolutions, recipes, encounters, items)`
  that leaves `validate_content` untouched. This is **idiomatic to this codebase** — the
  type chart, encounters, and skills are *all* separate id-cross-referenced registries, never
  nested inside `Species`. Stays strictly within `content.rs` + `content/**`.
- **(c) Defer evolutions/fusion content to M10a-rules/M10b** — **rejected**: M10a-rules
  imports these types; defining them here is the gating deliverable.
- **(d) New glob directories `content/fusion/`, `content/evolutions/`** (preserve the
  ADR-0057 fan-out property) — **rejected for this slice**: needs a `build.rs` edit (outside
  touches). Kept single-file via `include_str!` instead (see Decision §2).

## Decision outcome

**Chosen: (b).** Model "per-species evolutions" as a separate `SpeciesEvolutions` registry
and fusion as a `FusionRecipe` registry, both cross-referenced by `species_id`; gate their
integrity in a new additive `validate_evolution_fusion`, leaving `validate_content` and
`Species` byte-stable. This deviates from the spec's literal "`species.evolutions` field"
wording for a load-bearing reason (slice-boundary integrity + additive-without-breakage),
and is recorded here so M10a-rules/M10b consume the registries, not a `Species` field.

### 1. Shared content types (`game-core/src/content.rs`)

Derives mirror the existing content types — `#[derive(Debug, Clone, PartialEq, Eq,
Deserialize)]` (read-only RON data; **no** `Serialize`, **no** `SpacetimeType` — these are
game-core content, not schema rows; the server marshals them onto its own M10b rows).

- `EvolutionTrigger` — **exhaustive** enum, illegal-states-unrepresentable: `Level(Level)`,
  `Bond(Bond)`, `Item(u32)`. **No `#[non_exhaustive]`** — adding a future trigger variant
  must compiler-flag every `match` in M10a-rules (a deliberate OCP inversion: we *want* the
  exhaustiveness break). `Level`'s newtype `Deserialize` rejects `0`/`>100` at the RON
  boundary, so an illegal `Level` trigger is unrepresentable (parse-don't-validate); `Bond`
  accepts any `u8`, so `Bond(0)` (an always-true threshold) is rejected by the validator
  instead (§3).
- `EvolutionCondition { trigger: EvolutionTrigger, to_species: u32 }` — one branch.
- `SpeciesEvolutions { species_id: u32, evolutions: Vec<EvolutionCondition> }` — the
  registry row. The `species_id` field *is* the lookup key M10a-rules indexes by; it carries a
  small "validator tax" (a duplicate-`species_id` check, §3 d) that a `HashMap` model would
  not, accepted as the idiomatic RON-list shape consistent with every other registry.
- `FusionRecipe { a: u32, b: u32, to: u32 }` — order-independence is **not** a struct
  property; it is enforced by the dedup validator normalizing each pair to `(min(a,b),
  max(a,b))` (order-dependent dedup is the named anti-pattern).

### 2. Loaders — single-file `include_str!` (the `type_chart` precedent)

`const FUSION_RON = include_str!("../content/fusion.ron")` + `load_fusion`/`parse_fusion`,
and likewise `EVOLUTIONS_RON` + `load_evolutions`/`parse_evolutions` — the exact
`TYPE_CHART_RON` pattern (`content.rs:148`), with loud per-parse rejection
(`"<registry> parse error: {e}"`). Derived-form **species rows** are added as plain `Species`
rows in a new globbed part file `content/species/010-derived.ron` (the existing glob picks it
up with no `build.rs` edit; sorts after `000-core.ron`, so the `m8_9e_species_migration_parity`
prefix-equality gate stays green).

**Tradeoff vs. ADR-0057 fan-out (accepted):** ADR-0057 migrated five registries to glob dirs
so content-adding slices fan out, and *named M10 fusion recipes* as a motivating future
append. This slice keeps `fusion.ron`/`evolutions.ron` **single-file** because a glob
registry needs a `build.rs` edit (outside this slice's touches) — the same reason ADR-0057
left `type_chart` single-file ("one coherent matrix, rarely appended in parallel"). Fusion
recipes and the evolution table are small and low-parallel-churn today. **Follow-up:** a later
slice that includes `game-core/build.rs` in its `touches:` may migrate these two registries to
`content/{fusion,evolutions}/` glob dirs when they grow (purely additive, behavior-preserving,
same recipe as M8.9e).

### 3. The additive validator — `validate_evolution_fusion`

```
pub fn validate_evolution_fusion(
    species: &[Species], evolutions: &[SpeciesEvolutions],
    recipes: &[FusionRecipe], encounters: &[EncounterTable], items: &[ItemDef],
) -> Result<(), String>
```

One cohesive pure fn (errors-as-values, no clock/RNG), mirroring `validate_content`'s
many-branches-one-fn style. Checks run in a **deterministic order chosen so each proof-of-teeth
fixture isolates exactly one violation** (a fixture must not pass for the wrong reason —
the reward-hacking risk the red-team flagged):

1. **(d) registry well-formedness** — no duplicate `SpeciesEvolutions.species_id`; **no empty
   `evolutions: []` block** (a stub that would silently occupy a `species_id` slot and block a
   later real entry).
2. **self-reference** — reject `to_species == species_id` (a no-op "self-evolution" the
   reducer would happily re-apply). (Multi-node evolution **cycles** `A→B→A` are **deferred**
   to M10a-rules, where the `evolves_to` graph traversal lives — a named deferral; self-loops
   are caught here.)
3. **(c) dangling refs** — every `SpeciesEvolutions.species_id`, every
   `EvolutionCondition.to_species`, and every `FusionRecipe.{a,b,to}` must exist in the species
   id set; every `EvolutionTrigger::Item(id)` must exist in the items registry (symmetric to
   species dangling-refs — the spec mandates species refs; item refs are added because the
   `Item` variant ships in this slice and the registry is already in hand).
4. **trigger sanity** — reject `EvolutionTrigger::Bond(0)` (an always-true threshold; the
   `Level` analogue is already impossible at parse time).
5. **fusion coherence** — reject `a == b` (self-fusion is not a supported mechanic; a future
   ADR may add it) and `to ∈ {a, b}` (the "fusion" would reproduce an input).
6. **(b) derived-forms-not-wild** — `derived = {ev.to_species} ∪ {recipe.to}`; reject if any
   `EncounterTable` entry `species_id ∈ derived`. **Scope (named deferral):** this covers
   `EncounterTable` only; hardcoded server grant paths (the starter species in `join_game`,
   future quest rewards) are out of scope until/unless they become content-driven.
7. **(a) no duplicate fusion pair** — normalize `(a,b) → (min,max)`, reject a repeat
   (catches `(2,1)` against `(1,2)`).

### 4. Where the validator is gated (and the M10b obligation)

Within this slice, `validate_evolution_fusion` is exercised by a game-core **embedded-content
test** that loads the live species + evolutions + fusion + encounters + items and asserts
`Ok` — so `just ci` (→ `just test`) runs it on every build, and the seed's coherence
(derived forms genuinely absent from encounters) is a live gate, not just synthetic fixtures.

**M10b obligation (cross-slice contract, recorded here):** the server's `sync_content`
(`server-module/src/content.rs`) currently calls `validate_content` + `validate_encounters`;
**M10b MUST also call `validate_evolution_fusion`** (loading the two new registries) before
seeding so the integrity gate is live in production, not only in the game-core test suite.
This is the one piece the touch boundary defers to a later slice.

### 5. Append-only ids — no eval/baseline edit

`evals/append-only-ids.eval.mjs` flags only `baseline \ current` (removed/renumbered ids).
Adding derived species `4,5,6,7` keeps `{1,2,3} ⊆ current`, so the eval stays green with **no
baseline edit** (and no `evals/` touch). Within-version species-id uniqueness is still
enforced by the unchanged `validate_content`; the new validator adds only the
*registry-specific* uniqueness (no duplicate `species_id` block, no duplicate recipe).

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

Each integrity branch gets a synthetic fixture that **bites** (fails when the invariant is
violated, passes when fixed) and, where a wrong-reason pass is possible, **asserts on the
error text** and uses an otherwise-all-valid dataset so it cannot pass via a different branch:
- no-duplicate-pair — second recipe is the **reversed** `(a:2,b:1)`, not a literal duplicate
  (kills a raw-pair impl that skips normalization);
- derived-form-not-wild — the derived species is **present in the species set** (so it cannot
  pass via dangling-ref) and the error references the wild/encounter violation;
- dangling species ref (evolution target *and* fusion parent) + dangling item ref;
- self-evolution, `Bond(0)`, empty-evolutions-block, self-fusion `a==b`, `to ∈ {a,b}`;
- the **positive** gate: the live embedded seed validates `Ok`.
Plus a parse round-trip test pinning the RON syntax of all three `EvolutionTrigger` variants
(`Level`'s bare-int newtype `Deserialize` vs `Bond`/`Item`).

## Consequences

- **Positive:** the slice stays strictly within `content.rs` + `content/**`; `Species` and
  `validate_content` are byte-stable (zero blast radius into server-module); the registries
  are additive + append-only and idiomatic to the codebase; integrity is mechanical (ten
  proof-of-teeth), not author discipline; the exhaustive `EvolutionTrigger` compiler-flags
  M10a-rules on any new variant.
- **Negative / accepted:** the content shape diverges from the spec's literal "`species.evolutions`
  field" wording (recorded here; M10a-rules/M10b consume the registry); `fusion.ron`/
  `evolutions.ron` are single-file, briefly diverging from the ADR-0057 fan-out property until a
  later slice migrates them (build.rs-touching); `validate_evolution_fusion` is **not yet** wired
  into the production `sync_content` (M10b obligation, §4); multi-node evolution-cycle detection
  is deferred to M10a-rules (§3.2).
- **References:** corpus ADR-0019 (model authority), ADR-0006 (additive schema / content-is-data),
  ADR-0010 (falsifiable gates / proof-of-teeth), ADR-0057 (single-file vs glob precedent + the
  fan-out property this temporarily defers). The unchanged `validate_content` +
  `append-only-ids` eval are the existing gates this preserves.
