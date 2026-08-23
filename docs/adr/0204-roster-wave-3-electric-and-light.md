# 0204 — Roster Wave 3: Electric and Light affinities with reserved bands, one evolution edge per base form, and content superlatives as load-bearing constraints

**Status:** Accepted
**Date:** 2026-08-23
**Slice:** rw3b (M-postgate-roster-wave-3 rw3b — Electric and Light lines)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, evolution-fusion
**Decision:** Wave 3 adds an Electric glass-cannon line and a Light wall line under band 40..=49 (edges 100..=199), with exactly ONE outgoing evolution edge per base form so ADR-0176 D2's auto-evolution race is vacuous by construction.

---

## Context and problem statement

ADR-0145 accepted at pt-d3 left a residual: Electric and Light were the only two `Affinity` variants with zero species AND zero skills in the shipped roster. Wave 1 (pt-d1) took the tanky and fast-sweeper archetypes; wave 2 (pt-d2) took status and support. Wave 3 closes the gap by adding the two GDD §5 line-identities still unrepresented: Electric as a special glass cannon (Voltkit 40 → Voltarion 41) and Light as a special wall (Aurelet 42 → Aurelith 43).

The roster's type chart does not resist these choices. Light and Dark are mutually super-effective with no resist either way, so a Light line reads glassy against the doubled Dark roster unless its bulk carries it. Electric resists nothing but its own mirror, so it must win before it is hit — the archetype distinction follows from the chart's constraints rather than taste.

This slice adds the first-ever part file to the skills registry (`skills/070-wave3.ron` claims ids 40–49), the first evolution edges since pt-d2 (edges 100–101, for the two base forms), writes content superlatives that future waves must treat as load-bearing, and discovers that RW3-08's acceptance criterion is mechanically impossible for any slice that adds an evolution edge — the test file pins the edge set exactly and requires rewording before rw3c.

## Decision

### D1 — Affinity and archetype split by type-chart constraints

Electric is a special glass cannon: speed 82 (fastest base form yet), sp_attack 66 (highest shipped base), paid for with defense 40 (the lowest of any form in the roster). Light is the mirror spread: sp_defense 66 (highest shipped base), speed 46 (near the floor), trading initiative for survival where Electric trades survival for speed. Neither line starts ahead of the other on total BST (322 vs 326, both in the 318–328 band wave 1 established).

The type chart forces the split rather than allowing arbitrary pairing. Light and Dark are mutually super-effective with no resist either way, so a 66-sp_defense special wall survives where a 40-defense sweeper would not. Electric resists nothing but its own mirror, so glassy speed is the only win condition. The archetype is a constraint, not a taste choice.

### D2 — Bands: species ids 40–49, skill ids 40–49, evolution edges 100–199, filenames `070-wave3.ron` / `071-wave3-derived.ron`

Wave 3 claims ONE number across every registry to make band collisions easy to audit: species ids 40–49 (pre-reserved in-tree by `species/060-item-evo-derived.ron`), skill ids 40–49, evolution edge ids 100–199, filenames `070-wave3.ron` for base forms and `071-wave3-derived.ron` for evolved forms.

Species and skill ids are INDEPENDENT registries — species 40 and skill 40 are a mnemonic correspondence, not a collision risk. `skills/070-wave3.ron` is the FIRST part file the skills registry has ever had; it claims 40–49 and leaves 12–39 unclaimed for core growth. `skills/000-core.ron` was deliberately NOT retro-annotated with a band comment, because the collision check reads actual ids, not comments — a wider diff buys nothing.

The reserved band is mechanically enforced by the slice's own eval, so a drift out of the band fails loudly before merge.

### D3 — One outgoing evolution edge per base form makes level-based evolution races vacuous

ADR-0176 D2 establishes that auto-evolution makes level a RACE — a monster with exactly one eligible path evolves immediately, so an unconditional low-`min_level` edge silently kills every higher-level sibling branch.

Exactly one out-edge per wave-3 base form (Voltkit→Voltarion at `min_level` 20, Aurelet→Aurelith at `min_level` 22) makes that race VACUOUS by construction. Both edges are non-vacuous under rule R4 purely on `min_level > 1`, so the guarantee holds.

Level 20 is the registry's common-branch convention. The Light branch sits at 22 because bulk compounds — the higher level lets a glassy-by-type defensible form reach a defensive threshold before forced evolution.

### D4 — Numeric superlatives written into content comments are load-bearing design constraints on later waves

Voltarion's `sp_attack` is deliberately 102, below Cindershade's 104 (which `species/060-item-evo-derived.ron` names as "the roster's highest sp_attack"). Its speed is deliberately 98, below Venumbra's 100 (which `species/051-wave2-derived.ron` names as "the fastest form in the roster").

These numeric superlatives have no gate — no Rust validator enforces them. But they are public, committed prose in the content tree. A wave that ignored them would leave two silent doc-truth regressions in files this slice otherwise never touches.

This decision establishes the general rule: a numeric superlative written into a content comment is a constraint on later waves, binding them to maintain the claim or to explicitly revise the prose. It is a documentation-mediated contract, not a code-level one.

### D5 — Declared deviation from acceptance criterion RW3-08: test files must be extended for evolution edges

RW3-08 states: "The slice SHALL NOT modify Rust source other than `CONTENT_VERSION` and its own new test files."

That is mechanically impossible for ANY slice that adds an evolution edge OR a derived species, and TWO pre-existing Rust files had to be edited, not one:

1. `game-core/tests/eg3_evolution_graph.rs` pins the edge set EXACTLY — `t2` asserted `paths.len() == 10` and `t7` asserted `edge_ids == (1..=10)`.
2. `game-core/src/content.rs`'s test-only `EG1_TIER_ONE_IDS` pins the derived-species set EXACTLY (`[4, 5, 6, 9, 10, 22, 23, 30, 31]`), and its companion loop asserts every species NOT in that list is `tier: 0` — so an unlisted derived form fails loud.

Both were extended.

`expected_edges()` now pins edges 100 and 101 field-for-field alongside the original ten. The count literal became 12. Test `t7` now writes out the expected edge vector literally (because edge_ids are banded and deliberately non-contiguous: `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 101]`).

This is a declarative statement, not a request: RW3-08 needs rewording before rw3c, which faces the identical wall. No slice can add mechanics without extending the Rust test that pins the behavior it is testing.

### D6 — Sprites ship inert; each new row carries a NEW feature flag, not a palette-swap variant

Four `PLAN_TABLE` rows were appended to `client/art-src/generate_monsters.py`, each keeping ONE body plan across its evolution (matching the umbraquill→venumbra and gustwyrm→tempestrix precedent):

- Voltkit: `avian/small/bolt`
- Voltarion: `avian/large/bolt|openwings`
- Aurelet: `orb/small/halo`
- Aurelith: `orb/large/halo|skirt`

Two new feature branches were added to the shared draw functions — **`bolt`** (a zig-zag tail breaking a corner no other avian row touches) and **`halo`** (a DETACHED ring above the body, the only disconnected component any plan produces) — rather than shipping size-only variants of existing rows. The size-only approach would have passed the unique-`(plan, size, features)` check while still reading as a palette swap.

Sheets are NOT wired into the renderer: `client/src/render/placeholderAssets.ts` remains the sole provider, matching wave 2. Sprites ship inert and may be swapped without code changes once wiring lands.

A forward hazard for rw3c: `game-core/tests/pt_d3_tuning.rs` asserts `levels_by_species.len() == 7` derived from encounter tables. Placing species 40 and 42 in a table takes it to 9, and rw3c must extend that pin.

## Consequences

**Good.**

- Electric and Light affinities are now equidepth with the six others: each has a base form, a derived form, a two-skill learnset, and one guaranteed evolution.
- Reserved bands make id collision essentially impossible and future band audits cheap.
- One out-edge per base form is a provable precondition for vacuous evolution races, not a best-effort hope.
- Numeric superlatives in comments are now treated as contracts, so a reader standing at wave 4's content edit knows the claims that must hold.
- Evolution edges are mechanically tested alongside the type graph, not left implicit.

**Costs / accepted risks.**

- **Drift on acceptance criterion RW3-08.** The criterion as written is mechanically impossible for this slice and rw3c. A reword is a required follow-up before rw3c lands.
- **Encounter-table extension required.** The species are valid content (no reachability validator exists, and wild placement is rw3c's job), but placing them in a table makes rw3c dependent on extending `pt_d3_tuning` from 7 derived forms to 9. The pin is explicit.
- **No general-purpose art DSL.** The two new feature flags are row-specific (a `bolt` tail and a `halo` ring), not parameterized over all body plans. Wave 4's art author will inherit the same hand-written-row precedent, with the understanding that truly generic parameterization belongs in a future art-infrastructure slice, not in content.
- **Superlative claims are unverified at commit time.** The numeric constraints on Cindershade 104 and Venumbra 100 are human-visible only — no gate checks that Voltarion 102 < 104 or Voltarion speed 98 < 100. This is a review obligation and a design contract, not a machine-checked invariant.

**Follow-ups (deliberately not actioned here).**

- **Reword RW3-08 before rw3c.** Every slice that adds an evolution edge must extend the Rust test that pins the edge set. The criterion's blanket ban on Rust edits is contradictory and must be restated to allow test extensions.
- **Extend `pt_d3_tuning.rs` encounter pin.** The assertion `levels_by_species.len() == 7` must become 9 once encounter rows include species 40 and 42. rw3c must do this.
- **Promote encounter reachability validation.** `validate_evolution_fusion` already checks that derived forms are wild-legal; a companion rule requiring every wild-legal base form to appear in an encounter table belongs in rw3c or a following rules slice.
