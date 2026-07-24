# 0144 — pt-d2 roster wave 2: reserved-block content fan-out + a species-parameterized sprite generator that imports (never edits) the shared art module

**Status:** Accepted
**Date:** 2026-07-24
**Slice:** pt-d2 (M-playtest-d content pack — roster wave 2 + placeholder-replacement sprites; EARS pt-d2-1..12)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, ci-gates, tooling-docs
**Decision:** Concurrent content slices claim a reserved species-id + filename band (pt-d2 owns ids 20–29, files `05x-*.ron`); sprites come from a NEW `generate_monsters.py` that imports `generate_art.py` primitives instead of editing it, and slice-specific invariants live in a new auto-discovered eval, not the shared Rust test files.

## Context

M-playtest-d grows the roster from the 6 shipped forms toward the GDD §5 MVP bar (~16) and
replaces placeholder textures with per-species sheets, as **pure content** on the ADR-0057
glob-loaded pipeline — no schema, no new mechanics.

The milestone is deliberately fanned out: **pt-d1 (wave 1) and pt-d2 (wave 2) run
concurrently**, and at planning time pt-d1 had committed nothing, so its species ids, names,
files and asset slugs were unknowable. Everything below is driven by that constraint —
*two content slices must be able to author disjoint content, and be individually green, with
zero communication between them.*

Ground truth established before planning (all verified in-repo):

- `content/species/` is a **glob-loaded directory** (ADR-0057, `game-core/build.rs`): a new
  `content/species/NNN-*.ron` needs no code change. `parse_parts` (`content.rs:299`) parses
  **each file independently** as a complete RON `[ … ]` list and `extend`s the result — files
  are not textually concatenated, so every part file must be self-contained.
- Species row ids need not be contiguous or sorted. `evals/append-only-ids.eval.mjs` flags
  **removals only**; `m8_9e_species_migration_parity` (`content.rs:2167`) asserts only that
  the merged registry's ids 1–3 prefix is unchanged and `len >= golden.len()`.
- **No reachability validator exists.** A base species that appears in no encounter table is
  valid content; encounter tuning is slice pt-d3.
- `validate_content` / `validate_abilities` / `validate_evolution_fusion` already run over the
  **real merged registry** in `game-core` and `server-module` tests — the Rust validators are
  the authority for content integrity.
- `evolutions.ron` is a **single** `include_str!` file (not glob-loaded), and any content
  change forces a `CONTENT_VERSION` bump (`server-module/src/lib.rs`) plus a regenerated
  `evals/baselines/content-hash.json` (ADR-0073) — three files both waves must touch.

## Decision

### D1 — Reserved id + filename band as a communication-free concurrency protocol

pt-d2 claims **species ids 20–29** and the **`05x-` filename band** (`050-wave2.ron`,
`051-wave2-derived.ron`), leaving the natural next-free ids (7+) and low filename bands to
wave 1. Id gaps are legal (see Context), so the cost of the reservation is zero and it makes
a blind id collision — the one failure mode that would force a post-hoc renumber across two
files *and* `evolutions.ron` — essentially impossible.

Affinity/archetype are picked by an explicit tie-break rule rather than taste, so the two
waves stay disjoint without coordinating: **wave 2 takes the tail of the `Affinity` enum
among affinities that already have skills** (`Fire, Water, Plant, Electric, Earth, Wind,
Light, Dark` → **Dark, Wind**; `Electric`/`Light` are excluded because no skill of those
affinities exists and `content/skills/*` is out of this slice's touch set), and the **tail of
the GDD §5 archetype list** (**status, support**), leaving head (tanky, fast sweeper) to
wave 1.

The reserved band is mechanically enforced for this slice by the `W2-IDS` check in the new
eval, so a later edit that drifts out of the band fails loudly rather than colliding silently.

### D2 — A new `generate_monsters.py` that *imports* `generate_art.py`, never edits it

`client/art-src/generate_art.py` is a ~1200-line shared module that wave 1 must also extend to
produce its sprites. Editing it from both slices is a guaranteed hard conflict in the file
that is hardest to merge. Instead, pt-d2 adds a **new module** that imports the primitives it
needs (`Img`, `write_png`, `write_sheet_json`, `build_normal_sheet`, `upscale`, `light_sheet`,
`hflip`, `blob`, `TILE`, `OUT`, `PREVIEW`, `INK`, `SHADOW`). `generate_art.py` guards `main()`
behind `if __name__ == "__main__"`, and `OUT`/`PREVIEW` derive from the module's own directory,
so importing is side-effect-free and cwd-independent. **`generate_art.py` is not touched at
all** — not even to call the new builder.

This is DRY (the PNG codec and sheet-JSON writer are imported, never re-implemented) and it is
deliberately **not** a general art DSL: seven hand-written body-plan functions plus a
data table of nine species rows. Content is data; the drawing code is the smallest thing that
renders it.

### D3 — Distinct silhouette, not palette swap; asset naming `monster-<slug>`

Nine species get sheets: the five shipped forms with no sheet (Tidalin, Sproutlet, Pyroleo,
Embersworn, Steamveil) and the four new wave-2 forms. Each is drawn from one of **seven body
plans** (quadruped, bipedal-armored, serpentine-coil, rooted-sprout, amorphous-vapor, avian
with a size flag, orb with a wraith flag), so neighbours in a party or battle lineup never
share a silhouette — the H2 "visible divergence → attachment" bar is about shape first, colour
second. Files are `client/public/assets/monster-<slug>.{png,json}` plus a byte-identical-rects
`-normal` map, matching the emberkit convention exactly (96×128, 3 cols × 4 facings, 12
`mon_<face>_<col>` frames, 8 animations, `left` = `hflip` of the right-facing draw).

**Species 1's `monster-emberkit.*` is left untouched** — it is referenced by
`client/art-src/demo/index.html` and regenerating it would put an unrelated byte diff in a
content review.

### D4 — Slice-specific gates live in a new auto-discovered eval, not the shared Rust tests

`evals/run.mjs` auto-discovers `evals/*.eval.mjs` with no registry file, so a new eval is a
fully disjoint add — whereas the natural Rust homes (`game-core/src/content.rs` inline tests,
`server-module/src/content_tests.rs`) are shared files wave 1 will also edit *and* sit outside
this slice's declared touch set.

The new `evals/pt-d2-roster-wave-2.eval.mjs` deliberately carries **only invariants no
existing gate asserts**. Stat ranges, dangling skill/ability references and evolution
integrity stay owned by the Rust validators (the authority); the eval adds:

- the **reserved-band** rule (D1),
- the affinity/STAB design bar,
- the **orphan-derived-form** rule — every species in `051-wave2-derived.ron` must be some
  evolution's `to_species` exactly once. Nothing today catches a derived form that no
  evolution reaches: `validate_evolution_fusion` walks *from* evolutions, never *to* the
  derived file. This is the genuinely novel tooth.
- `derived BST > source BST` (a line invariant Rust does not check),
- sprite sheet-set/format/normal-registration, and the **silhouette-distinctness** tooth.

`SPR-SET` iterates an **explicit `COVERED` id→slug map, not the whole registry** — a total
gate would go red the moment wave 1 merged species this slice cannot know the slugs of. The
eval reports unmapped registry species as informational, and promoting it to a total function
once both waves have landed is a named follow-up.

### D5 — Keep the pixel-level silhouette tooth (a considered-and-rejected simplification)

A `/simplify` pass argued the pixel check should be replaced by a uniqueness check over the
generator's data table (body plan + size + feature flags), avoiding a hand-rolled PNG decoder.
We took **both**, not the substitution: the data-table check is cheap and catches duplicate
*intent*, but only the pixel check catches a drawer that **ignores** a feature flag — i.e. two
rows distinct on paper that render identically, which is precisely the palette-swap failure the
spec's "distinct silhouette" bar exists to prevent. Since the producer is deterministic and
in-repo (`write_png` emits 8-bit RGBA, non-interlaced, single `IDAT`, filter byte 0 on every
scanline), the decoder is ~40 lines of `node:zlib` that **throws loudly** on any other shape
rather than silently returning an empty mask — strictly better than adding a `pngjs`
dependency for a single gate.

The tooth compares **decoded pixels, never raw PNG bytes** (zlib output is not guaranteed
stable across library versions, which would make a byte-baseline a cross-machine flake), and is
**translation-invariant**: masks are cropped to their alpha bounding box before comparison, so
"the same silhouette shifted one pixel" is flagged, not excused. A counter-fixture of two masks
differing only by a 1 px offset must fail the check.

### D6 — Abilities and triggers left thin, deliberately

Only Tempestrix takes an ability (`Some(3)` Regeneration — the pivot payoff that makes the
evolution a gain beyond stats). Abilities 1/2 are `StatusImmunity(Burn)`/`(Sleep)`, wrong for
Dark/Wind, and `content/abilities/*` is out of the touch set. No `Item(…)` evolution trigger:
`content/items/*` holds only ids 1–3 (Lure Berry, Power Root, Antidote) — there is no evolution
stone, and adding one is out of scope.

Both new lines have thin offensive kits, because exactly **one Dark skill and one Wind skill
exist**. Topping up the skill registry is permitted by the milestone but not by this slice's
touch set — it is handed to **pt-d3** as a balance finding, and the playtest is the balance test.

### D7 — Sprites ship inert, on purpose

Nothing in `client/src` consumes monster spritesheets today: `client/src/render/placeholderAssets.ts`
generates procedural textures and is the only `AssetProvider` (`world.ts:71`). Even species 1's
existing sheet is unwired. These assets are therefore **staged**, not live, and wiring them is
deliberately out of scope — it would touch `client/src/render/**`, well past a content slice.
This is the content-pipeline win the milestone sketch calls out: the art can be reviewed, and
swapped, without any code change.

## Consequences

**Good.** Two content slices can run truly concurrently. Adding a species stays a pure data
edit. The silhouette bar is mechanically enforced instead of asserted in a review comment. The
shared art module gains a companion rather than a fork.

**Costs / accepted risks.**

- **Unavoidable shared-file overlap with wave 1**: `content/evolutions.ron` (single file, both
  waves append), `server-module/src/lib.rs` `CONTENT_VERSION`, and
  `evals/baselines/content-hash.json`. All three fail **loudly** (merge conflict or a red
  content-version eval), never silently. Mitigations: this slice appends contiguous blocks at
  EOF and reflows nothing, and the version bump + baseline regeneration are the **last** commit,
  so the second slice to merge re-runs one deterministic regeneration step. The hash covers the
  whole merged tree, so the baseline must always be **regenerated, never hand-merged**.
- The reserved band is a convention held by this ADR and one eval check, not a repo-wide
  registry. If a third concurrent content slice appears, the band table belongs in the spec.
- New base species are **unobtainable in-game** until pt-d3 adds encounter rows. Intended, and
  valid content — see Context.
- Two independently-authored per-species art generators (one per wave) would be a duplicated
  concept. Flagged in the handoff: whichever wave lands second should import this module rather
  than add a third.
