# 0149 — item-triggered evolution content (species 7/8 branches, id band 30..=39)

**Status:** Superseded
**Superseded-by:** ADR-0177 (the Item-discrete-trigger reducer shape only — D3's 30..=39 id-band reservation and the species content it governs SURVIVE and remain binding; ADR-0177 D1)
**Date:** 2026-07-25
**Slice:** B (M-postgate-evolution-fusion-hardening — item-triggered evolution content; EARS B-1..B-5)
**Supersedes:** —
**Amends:** ADR-0144 (D1 reserved-id-band discipline is extended: 30..=39 is now claimed by this slice; roster wave 3 takes 40..=49), ADR-0143 (pt-d1's `pt_d1_2` exact-branch pin is tightened, not deleted — species 7/8 now legitimately carry two branches)
**Subsystems:** evolution-fusion, content
**Decision:** Species 7/8 each gain a second, Item-triggered branch (`Item(4)->30`, `Item(5)->31`) declared FIRST in their existing block; targets are new derived species 30/31 in id band 30..=39; both ItemDef rows ship UNSTOCKED.

## Context

Slice B of the converged evolution/fusion design ships Drew's worked example (an
"elemental energy" item that transforms a monster) through the evolution-trigger
primitive's already-declared `Item(id)` variant, with **zero Rust engine changes**:
`resolve_evolution` (`game-core/src/evolution/eligibility.rs`) is already a FIRST-wins,
declaration-order, exhaustive match over `EvolutionTrigger::{Level, Bond, Item}` with no
wildcard arm, and `validate_evolution_fusion` already rejects an `Item(id)` naming a
non-existent item (`game-core/src/content.rs`).

Grounding the slice against live code surfaced one fact the spec asserted incorrectly:
`Item(id)` is **declared** but not **reachable**. The registry contained zero `Item`
triggers before this slice, and the only production resolver call sites
(`server-module/src/evolution.rs` `compute_evolves_to`, reached from the `evolve` reducer
and from `sync_content_inner`) hardcode `applied_item = None`; `evolve(ctx, monster_id)`
takes no item argument, and `use_battle_item` only accepts items with `cure_status`. That
is a scheduling fact, not a defect in this slice's scope — but it governs three of the
decisions below.

## Decision detail

1. **Sources: species 7 (Cragling, Earth) and 8 (Shadelet, Dark)** — the two wave-1 base
   forms, chosen from the spec's menu of {7, 8, 20, 21}. Rationale: `pt-d2`'s
   `findEvoOrphansAndBadSources` "Gap 1" rule
   (`evals/pt-d2-roster-wave-2.eval.mjs`) constrains any wave-2 **base** source (20, 21) to
   target only members of `051-wave2-derived.ron`, so using 20/21 would have forced the new
   derived forms into the wave-2 files — where `ALLOWED_AFFINITIES = {Dark, Wind}` would in
   turn have forbidden the Water/Fire elemental flavour the worked example is about.
   Choosing 7/8 keeps the new content in its own file and its own band, with no edit to a
   prior wave's gate semantics. B-2 is satisfied trivially: neither branch targets 6.

2. **The `Item` entry is declared FIRST inside each existing block**, ahead of the existing
   `Level` branch. `resolve_evolution` is FIRST-wins over declaration order, and `Item`
   provably never matches when `applied_item` is `None` (pinned by the existing
   `item_trigger_never_fires_passively` test), so this is **behaviour-neutral for every
   input reachable today** — every passive `evolves_to` computation is unchanged. It is not
   neutral for the future: once a reducer supplies `Some(item_id)` alongside the monster's
   real level, a level-18+ Cragling applying item 4 must resolve to 30, not fall through to
   `Level(18) -> 9` and consume the item for the wrong target. Declaring `Item` first fixes
   that at zero cost now instead of requiring a content edit later. B-1's constraint is on
   the *block* ("append to the EXISTING `evolutions:` list — not a new `SpeciesEvolutions`
   block"), not on intra-list position.

3. **New derived species 30 "Tidecrag" (Water) and 31 "Cindershade" (Fire)** in a new file
   `game-core/content/species/060-item-evo-derived.ron`, claiming **id band 30..=39**
   (ADR-0144 D1 pattern; roster wave 3 takes 40..=49). New species are mechanically forced,
   not scope creep: `validate_evolution_fusion` rejects a dangling `to_species`, and every
   evolution target must be non-wild, so the branch cannot point at an existing wild form
   and pointing it at an existing derived form would produce a second, redundant path to a
   form another line already owns.

4. **Sidegrade stat rule (deliberate, gated):** `BST(30) = 452` and `BST(31) = 466` sit
   **above** their sources (318, 322) but **below** their level-branch siblings
   (Stoneward 455, Umbrafang 470), inside the established evolved-tier band 440..=490. The
   item path is a sidegrade bought with a consumable, not a power-creep bypass of the level
   grind — and the stat spreads differ in kind (30 is a bulky special attacker, 31 a fast
   special attacker) so the choice is a real fork rather than a strictly-worse option.
   Movesets keep one same-affinity STAB move first (30: Water Gun, 31: Fire Fang) and one
   heritage move from the source's affinity (30: Sandblast/Earth, 31: Toxic Sting/Dark).

5. **The two ItemDef rows ship UNSTOCKED — a recorded deviation from EARS B-3.** B-3 says
   the rows "SHALL ship via the existing M13b shop-content pipeline to supply the two new
   trigger items"; the rows do ship through that pipeline
   (`game-core/content/items/000-core.ron`), but `game-core/content/shops/000-core.ron` is
   **not** touched. Rationale: because nothing can supply `applied_item` yet, a stocked item
   would be a player-facing trap — a live playtester could spend ~16 wild-battle wins' worth
   of gold on an item that `use_battle_item` rejects with "not a cure item" and that no
   other reducer accepts. Shop stocking (and its price) lands with slice **B2** below, in the
   same PR as the reducer that makes the item usable, so the item becomes buyable and useful
   in one step. `sell_price: 200` is authored now so B2's buy price follows the shop file's
   own documented 40% convention (`buy = sell * 5 / 2 = 500`) without re-litigating it. The
   spec has been amended in place to record this deferral.

6. **Reachability residual + slice B2 (the honest consequence).** This slice ships content
   that is **inert this round**: items 4/5 are unobtainable, so the `Item` branches cannot
   fire and species 30/31 are unreachable. Nothing regresses (behaviour-neutral per D2, and
   no gate requires an ItemDef to be obtainable), but this round did **not** ship a
   player-facing feature. Slice **B2** — `apply_evolution_item(monster_id, item_id)` reducer
   (delegating to the same `resolve_evolution`), `consume_one` on success, Use-Item UI wiring,
   shop stocking, and sprites for 30/31 — is spawned in the spec and must land before this
   content is playtestable. B2 must reject a wrong-item application explicitly rather than
   letting it fall through to a level/bond branch.

7. **`pt_d1_2_evolution_blocks_for_7_and_8_are_exact` is TIGHTENED, not deleted.** Its
   `assert_eq!(blocks[0].evolutions, vec![want])` pins a length-1 vector, so *any* second
   branch breaks it (cardinality, not order). The replacement keeps every guarantee it had
   and adds one: exactly one block per source, exactly two branches, the pinned
   `Level(18)->9` / `Level(20)->10` branch still present **verbatim**, and the other branch
   is an `Item` trigger pointing at the declared new form. A weaker "contains the level
   branch" assertion would have let a future slice silently replace the level payoff.

## Consequences

- **Good:** the registry gains its first live `Item` trigger and the eval suite gains an
  Item-trigger dangling-reference check (`evals/evolution-fusion-content-integrity.eval.mjs`
  previously mirrored only the species half of validator rule 3 — a documented gap this
  slice is the first content to expose). The FIRST-wins ordering trap is closed before any
  reducer can hit it.
- **Bad / accepted:** inert content this round (D6). `CONTENT_VERSION` 15 -> 16 and a
  content-hash baseline churn are spent on content no player can reach yet — the cost of
  splitting the data drop from the reducer, which is what keeps this slice engine-free and
  independently reviewable.
- **Watch:** species 30/31 have no spritesheets. No gate requires one
  (`monster-spritesheet-format` globs existing files; `pt-d2`'s COVERED list is a fixed
  literal), and they are unreachable, so this is safe today — but art is a hard prerequisite
  for B2, not an optional follow-up.
- **Band discipline:** 30..=39 is now consumed. A roster wave 3 that assumes "next free band
  after wave 2" must take 40..=49.
