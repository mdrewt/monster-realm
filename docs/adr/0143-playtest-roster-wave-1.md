# 0143 — pt-d1 playtest roster wave 1: two new species lines (Earth + Dark) as pure ADR-0057 content, shipped data-complete but not yet wild-obtainable

**Status:** Accepted
**Date:** 2026-07-24
**Slice:** pt-d1 (M-playtest-d content pack — roster wave 1; EARS pt-d1-1..6)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, evolution-fusion, client-ui
**Decision:** Add species 7–10 (two Earth/Dark lines, one evolution each) in a NEW glob-loaded species part file, plus two `evolutions.ron` blocks and four albedo sheets; bump `CONTENT_VERSION` 12→13; they stay unreachable until a later slice.

## Context

`M-playtest-d-content-pack.spec.md` grows the roster from 6 forms toward the GDD §5 MVP
target (~16) ahead of the playtest gate. Slice **pt-d1** is wave 1: **+2 base species lines
with evolutions**, archetype coverage per GDD §5 (tanky / fast sweeper / status / support),
affinity spread across the existing chart, learnsets drawn **only** from the existing
11-skill set, and one spritesheet per new form at the "distinct silhouette + palette" bar
(H2 attachment). **No schema, no new mechanics, no new skills.**

The slice's declared `touches:` set is `game-core/content/species/*`,
`game-core/content/evolutions.ron` and `client/public/assets/monster-*`. That constraint —
not aesthetics — drives several decisions below.

A sibling slice **pt-d2 (roster wave 2) ran concurrently with an identical declared touch
set**. Minimising the textual collision surface with it is an explicit design goal here.

## Decision

### D1 — New species land in a NEW part file, never by editing an existing one

`game-core/content/species/` is an ADR-0057 fan-out directory: `build.rs` globs `*.ron` in
sorted filename order. Wave 1 therefore adds **`020-playtest-wave1.ron`** rather than
appending to `000-core.ron` / `010-derived.ron`.

Three reasons, in order of weight:

1. **It preserves the registry-prefix invariants.** `content.rs` pins `000-core.ron` as a
   byte-identical *prefix* of the merged registry (`SPECIES_GOLDEN`, and
   `m8_9e_species_migration_parity`). A file sorting after `010-` is purely additive to
   both.
2. **It makes the pt-d2 collision impossible where it can be made impossible.** Two new
   files with different names merge without conflict; two appends to one file do not.
3. It keeps each authoring wave reviewable as one artifact.

**Id-range reservation (load-bearing, not bookkeeping).** Because the species directory is
glob-merged, two slices that independently claim the same ids produce a *clean-looking*
git merge whose only symptom is a `duplicate species id` error from `validate_content` at
test/publish time. pt-d1 therefore publishes its reservation in the part-file header and
here: **pt-d1 owns species ids 7 through 10; wave 2 and later must start at 11.**

### D2 — Affinities are Earth and Dark, because they are the only unused affinities with a skill

The type chart defines 8 affinities; content covers only Fire/Water/Plant. Of the five
unused, the skill registry has a skill for **Earth** (9 Sandblast) and **Dark** (11 Toxic
Sting) — and **Wind** (10 Hailstrike), reserved for wave 2. **Electric and Light have no
skill at all**, so a species of either affinity would have no same-affinity move, and
`content/skills/*` is outside this slice's touches ("no new skills" is explicit scope).

Reservation for later slices: **wave 2 takes Wind; Electric and Light are blocked on a
slice that owns `content/skills/*`** (pt-d3 under the spec's "top up toward ~12" licence).

### D3 — The roster

Stat order below is the `StatBlock` named-field form used by every existing row
(`base_stats: (hp: …, attack: …, defense: …, speed: …, sp_attack: …, sp_defense: …)`).

| id | name | affinity | archetype | hp/atk/def/spd/spa/spdef | BST | learnset | ability |
|---|---|---|---|---|---|---|---|
| 7 | Cragling | Earth | tanky (base) | 60/48/75/30/40/65 | 318 | 9 Sandblast, 1 Ember | — |
| 8 | Shadelet | Dark | status (base) | 44/46/44/74/62/52 | 322 | 11 Toxic Sting, 4 Aqua Jet | 2 Vital Spirit |
| 9 | Stoneward | Earth | support (evo of 7) | 90/62/105/38/60/100 | 455 | 9 Sandblast, 5 Vine Whip | 3 Regeneration |
| 10 | Umbrafang | Dark | fast sweeper (evo of 8) | 68/92/60/118/72/60 | 470 | 11 Toxic Sting, 2 Fire Fang | 2 Vital Spirit |

Base BSTs (318, 322) sit inside the existing base band (318/328/318); evolved BSTs (455,
470) sit inside the existing evolved band (479/470/450), so **no new form is the strongest
thing in the game on total** — only on its archetype axis (Cragling has the lowest speed
and highest base defense; Stoneward the highest bulk; Umbrafang the highest speed;
Shadelet the highest base speed among bases with the lowest defense).

Both evolutions are single-branch `Level` triggers (7 → Level(18) → 9; 8 → Level(20) → 10).
Flameling already demonstrates branch evolution *and* the `Bond` trigger; a bond-gated
payoff would make a short playtest's outcome non-deterministic, so wave 1 stays on levels.
No `Item` triggers — they would couple the slice to `content/items/*`, which is out of scope.

**Learnset selection is AI-aware, and its limits are recorded honestly.**
`pick_best_skill` (`game-core/src/combat/ai.rs`) scores `power × effectiveness × stab`
(stab 3 vs 2). Partners were chosen so the same-affinity move actually *wins* a neutral
matchup where possible: Cragling picks Sandblast (35×10×3 = 1050) over Ember (40×10×2 =
800) neutrally, and Ember covers Plant; Stoneward likewise picks Sandblast over Vine Whip
(45×10×2 = 900), with Vine Whip covering Water.

The Dark line is the honest exception. Toxic Sting is power 20, so **no two-skill Dark
moveset exists in which the AI selects Toxic Sting on a neutral matchup** — any partner
with power ≥ 30 outscores it. Wave 1 accepts this rather than shipping a single-skill
moveset (which would risk a PP-exhaustion edge on an AI-driven monster). The full picture,
worked through exhaustively against the shipped chart during review:

- **Shadelet (8)** picks Aqua Jet against Fire/Earth/Wind/Light/Dark defenders, and **does**
  pick Toxic Sting against Water and Plant, where Aqua Jet is not-very-effective
  (600 > 400). So the poison genuinely lands — just not on neutral matchups.
- **Umbrafang (10)** never picks Toxic Sting against anything: Fire Fang wins even at
  half effectiveness (650 > 600). Its Dark STAB is **player-only**.

Neither line is AI-controlled today (only wild monsters are, and none of the four is
wild-obtainable — D4), so this affects nothing at runtime yet. It becomes real the moment
a later slice makes species 8 wild, which is why it is written down here rather than
discovered then. The Earth/Dark STAB power gap is a residual for the slice that owns
`content/skills/*`.

**Ability assignments** de-orphan ability 2 (Vital Spirit), which no species referenced
before this slice, and give species 9 the registry's first *evolved* form carrying an
ability at all. Note honestly: Vital Spirit grants Sleep immunity and **no skill applies
Sleep**, so it is thematically live but mechanically inert today — exactly as ability 1
(Flame Body / Burn immunity) already is. This is recorded, not fixed here.

### D4 — The new forms are deliberately NOT wild-obtainable, and that is the slice's biggest accepted cost

`game-core/content/encounters/*` is **outside** the declared touches, and the spec assigns
encounter placement to **pt-d3** ("encounter/recruit/economy tuning pass"). The starter is
hardcoded (`STARTER_SPECIES_ID = 1`) and there is no grant-monster dev reducer. Therefore:

> **Species 7, 8, 9 and 10 are unreachable in a running game until pt-d3 places 7 and 8 in
> an encounter table.** Wave 1's player-visible change is zero.

This was challenged in review as a blocker and is accepted deliberately, because widening
into `encounters/000-core.ron` is not the cheap edit it appears to be:

- **It changes live battle mechanics for the first time.** No species currently learns
  skills 7–11, so `sets_weather` and `applies_status` are *dead data*: no live battle has
  ever had `weather != None`. Putting Cragling in zone 0 makes the AI pick Sandblast
  against the Fire starter (2100, vs Ember's 400 at Fire-into-Fire), setting Sandstorm —
  and Earth is Sandstorm-immune, so a wild Cragling chips the player 1/16 max HP per turn
  while taking none. That is an unplaytested asymmetric DoT, not a content tweak.
- **It breaks an out-of-scope e2e test.** `client/e2e/recruit.spec.ts` hardcodes its
  flee-on-danger predicate to `affinity === 'Water'`, and its `MAX_ENCOUNTERS` flake budget
  is justified by per-encounter success probabilities that assume the current zone-0
  composition. Earth is super-effective on the Fire starter, so adding Cragling makes the
  spec fail to flee from a lethal matchup and invalidates that justification. The file is
  outside pt-d1's touches and has a documented CI-flake history.

Deferring is therefore the *smaller* change, not the lazier one. pt-d3 must place species 7
and 8, generalise the recruit e2e flee predicate to "affinity super-effective against my
starter", recompute the encounter budget, and take the first live-Sandstorm runtime proof.

**The gap is named, not silently left:** the invariant "every species is obtainable
(encounter ∪ evolution target ∪ fusion result ∪ starter)" is GREEN on master and would be
RED under this slice, so it is *not* added as a gate here. It is handed to pt-d3 as the
acceptance test that closes this decision.

### D5 — Spritesheets ship albedo-only, generated by a script committed as an appendix to this ADR

Four sheets — `monster-{cragling,shadelet,stoneward,umbrafang}.{png,json}` — in the
emberkit format (96×128, 12 frames `mon_{down,up,right,left}_{idle,walk0,walk1}` on a 3×4
grid of 32×32 cells, 8 animation keys, 8-bit RGBA non-interlaced PNG).

Two sub-decisions:

- **No `-normal.*` sheets.** Emberkit ships them only because its generator emits them.
  Nothing in `client/src` consumes a normal map — there is no light pass — so shipping four
  more unused binaries is YAGNI. Deferred with the HD-2D pass (ADR-0004).
- **The generator is not `client/art-src/generate_art.py`.** That file is the tracked SSOT
  for every other asset but sits **outside this slice's declared touches**, and it is a
  1200-line file the concurrent wave-2 slice would also have edited. Extending it here
  would have been both a scope breach and a near-certain conflict.

  Committing binaries whose generator is untracked is a real SSOT violation, so the
  mitigation is explicit: **the generator used is committed verbatim as
  `docs/adr/0143-appendix-gen-wave1.py`**, a standalone script that imports the shared
  primitives from `client/art-src/generate_art.py` and emits exactly the four sheets. The
  assets remain regenerable from tracked source; only the *entry point* lives beside this
  ADR instead of in `art-src/`. Folding it into `generate_art.py` proper is a named residual.

Silhouette/palette deltas (the H2 "distinct silhouette" bar — none may read as an emberkit
recolour, which is a round two-eared fox-kit with a curled tail):

- **Cragling** — rectilinear boulder, no ears, no tail, flat crest, four stubby feet;
  slate → ochre.
- **Stoneward** — the same rectilinear language scaled up with a shoulder shelf and two
  back spires breaking the top silhouette; basalt → moss.
- **Shadelet** — tall and thin, one long horn-ear, wispy trailing tail, one oversized eye;
  indigo → violet with a cyan catchlight.
- **Umbrafang** — low, crouched, elongated, twin downward fangs, forked tail, swept-back
  ear; near-black → magenta rim.

**Honest limit of the machine gate:** EARS pt-d1-5 checks sheet *format* and that the four
PNGs are pairwise byte-distinct. That is a non-identity floor, **not** a proof of visual
distinctness — four recolours of one silhouette would pass it. Silhouette distinctness is a
review-judged criterion, and the spec explicitly allows Drew to swap the PNGs post-hoc with
no code change.

### D6 — `CONTENT_VERSION` 12 → 13 is required by correctness, not by a gate

`server-module/src/content.rs` early-returns from `sync_content_inner` when the DB's stored
version equals `CONTENT_VERSION`. Without the bump, species 7–10 would validate, hash and
pass CI while **never reaching a deployed database** — the ADR-0054 silent-skip trap. Note
that `content-version.eval.mjs` does *not* force the bump (it passes if the version is left
at 12 and only the hash baseline is refreshed), so nobody should "optimise" it away; EARS
pt-d1-6 pins it with a source scan.

The paired obligation is `evals/baselines/content-hash.json`, a sha256 over the whole
`game-core/content/` tree. The eval's error message advertises a `--update` flag that **is
not implemented**; the baseline is written by hand from
`hashContentDir('game-core/content')`, and must be computed **last**, after every content
byte is final.

### D7 — RON comment hygiene is an invariant, not a style preference

Two evals parse the RON text with regexes after stripping **whole-line `//` comments only**:
`append-only-ids.eval.mjs` scans `/\bid:\s*(\d+)/g` over the species directory, and
`evolution-fusion-content-integrity.eval.mjs` scans `species_id:` / `to_species:` over
`evolutions.ron`. A *trailing* comment is not stripped, so:

- `// … (id: 7) …` in a species file injects a phantom stable id into the append-only scan;
- `// Shadelet -> Umbrafang (species_id: 10)` in `evolutions.ron` fabricates a phantom
  evolution block that inherits the next real block's targets — which surfaces as a bogus
  "species 10 has a self-evolution" failure.

`\b` does *not* match `species_id:`/`skill_id:` in real fields (`_` is a word character), so
the only injection vector is comment prose. **Rule adopted:** no *trailing* comment in a
species part file or in `evolutions.ron` may contain `id:`, `species_id:` or
`to_species:` — use the existing `id=1` convention (already used by `// Flame Body (id=1)`)
instead. Whole-line comments are stripped by both scanners and stay unrestricted.

This is **gated, not merely documented** (EARS pt-d1-7). Review's objection was decisive:
a convention stated in a wave-1 file header binds nobody, and the species registry is
authored one part file per wave, so wave 2 would inherit the hazard and none of the rule.
`pt_d1_7_ron_comments_carry_no_id_shaped_needles` therefore scans the whole species
directory plus `evolutions.ron`, not just this slice's files. Half the failure mode is
loud (a phantom `species_id:` fails `evolution-fusion-content-integrity` as a bogus
self-evolution); the species-side half is silent, which is exactly why it needs a gate.

### D8 — the STAB invariant is adopted registry-wide, deliberately

EARS pt-d1-3 asserts that **every** species in the merged registry can learn at least one
skill of its own affinity — not just the four new rows. Verified green for all six
pre-existing forms, so it costs nothing today.

Scoping it to ids 7–10 was considered and rejected. The rule is what makes an affinity
mean something (a species whose typing it can never express is a data bug, not a design),
and it is the *only* invariant in this slice that no existing validator enforces. Adopting
it registry-wide is what turns D2's "Electric and Light are blocked on a skills slice" from
a note into a mechanism: a later wave that adds an Electric species without adding an
Electric skill now fails a gate instead of shipping a species that cannot use its own type.
The assertion message names D2 so that failure is self-explanatory.

The cost is honest: this test lives in a file named for pt-d1 but constrains every later
wave. Promoting it into `validate_content` proper is a reasonable follow-up; it was not
done here because that function's signature is fixed by external callers and widening it
is not a content slice's business.

## Consequences

**Positive.** The ADR-0057 content pipeline is exercised at a second fan-out wave with zero
code change. Archetype and affinity coverage double (3 → 5 affinities represented, all four
GDD §5 archetypes present). Ability 2 stops being orphaned. Two evolution chains exist
where one did.

**Negative / accepted.**
- Wave 1 is invisible to a player until pt-d3 (D4). Reviewers should judge it as
  foundation, not feature.
- Earth and Dark have one weak skill each (35 and 20 power), so both new lines have
  materially worse STAB than the Fire/Water/Plant lines.
- `sp_attack`/`sp_defense` remain inert (`damage.rs` uses `attack`/`defense` only), so those
  columns encode design intent the engine does not yet implement — pre-existing, but this
  wave doubles down on it.
- Stoneward (105 def / 100 sp_def + Regeneration, best move 35 power) is a stall shell;
  damage's `max(1, …)` floor prevents a true loop, but PvP turn counts could get long.

**Merge hazard for whoever lands second (pt-d1 vs pt-d2).** A `git merge-tree` of the two
branches was run during review: it produces **four visible conflicts and no silent
corruption**, and the two waves' species ids do not overlap. The full shared surface:

| File | Resolution |
|---|---|
| `evals/baselines/content-hash.json` | **Recompute** — never take a side. The hash covers the whole content tree, so after both waves land it is a hash neither branch ever computed. |
| `server-module/src/lib.rs` (`CONTENT_VERSION`) | Re-bump to the next free value and keep **both** history lines. |
| `game-core/content/evolutions.ron` | **Keep both stanzas.** A single non-glob file; a resolution that drops one side is caught by nothing generic, which is why pt-d1 pins its own two blocks (EARS pt-d1-2). |
| `docs/adr/DIGEST.md` | Generated — re-run `just adr-digest`, never hand-merge. |
| `ARCHITECTURE.md` | Both waves touch the same registry-table row and the id-reservation bullet. |
| the ADR **number** | Each wave must hold a distinct reserved number; `adr-digest` keys on the 4-digit filename prefix. |

The *silent* failure mode worth naming: the species registry is a glob-merged **directory**,
so two waves claiming the same ids merge with **zero git conflict** and surface only as a
`duplicate species id` from `validate_content` at publish time. That is why the id
reservation is written into the part-file header and `ARCHITECTURE.md`, not just into review
notes. (Verified during review that wave 2 claims a disjoint range, so this did not fire.)

## Considered alternatives

- **Widen into `content/encounters/*` so the wave is playable now** — rejected: it drags in
  first-ever live weather mechanics and an out-of-scope, flake-prone e2e file (D4). pt-d3
  owns it.
- **Edit `client/art-src/generate_art.py`** — rejected: outside the declared touches and a
  1200-line conflict surface against the concurrent wave-2 slice (D5).
- **Four separate species part files, one per form** — rejected: no collision benefit over
  one file (the filename is what disambiguates) and four headers to keep consistent.
- **Bond-triggered evolution for the sweeper line** — rejected: non-deterministic payoff
  inside a short playtest (D3).
- **A single-skill `[11]` moveset so the AI actually uses Toxic Sting** — rejected: risks a
  PP-exhaustion edge on an AI-driven monster for a benefit that only matters once the line
  is wild-obtainable (D3).
- **Adding the "every species is obtainable" invariant as a gate here** — rejected: it is
  green on master and would be red under this slice, so it would silently widen pt-d1 into
  encounter placement. Handed to pt-d3 (D4).
- **Updating `evals/baselines/species-ids.json` to `[1..10]`** — rejected for this slice.
  The eval only checks *retention*, and the baseline has been stale at `[1,2,3]` since
  species 4–6 landed, so ids 4–10 are unguarded against removal. Fixing that is a real
  improvement but it is an undeclared policy change on a shared baseline and a third
  collision file with wave 2. Recorded as a residual chore.

## Residuals

1. Fold `0143-appendix-gen-wave1.py` into `client/art-src/generate_art.py` as a
   `build_monster(slug, ramps, draw_fn)` parametrisation, and refresh the `art-src/README.md`
   asset inventory. → wave 2 or a dedicated art-generator slice.
2. `-normal.*` sheets for all monster forms, if/when the HD-2D light pass lands (ADR-0004).
3. Earth/Dark skill power gap → the slice that owns `content/skills/*`.
4. Wild obtainability of species 7 and 8 + the recruit-e2e generalisation + the first
   live-Sandstorm runtime proof → **pt-d3** (D4).
5. Electric and Light affinities remain unrepresented; blocked on skills (D2).
6. `speciesId → spritesheet` client wiring — nothing in `client/src` loads
   `client/public/assets/monster-*` (the renderer uses procedural `placeholderAssets.ts`),
   so all monster sheets including emberkit's are currently inert. A client slice.
7. `evals/baselines/species-ids.json` stale at `[1,2,3]`; ids 4–10 unguarded.
9. **`evals/content-version.eval.mjs`'s `readContentVersion` is defeatable** — it takes the
   first substring hit of `CONTENT_VERSION: u32 = `, so a constant merely *ending in* that
   name (`MIN_SUPPORTED_CONTENT_VERSION`) declared above the real one shadows it, and the
   gate reports the decoy's value. Red-team demonstrated all three version gates reporting
   13 while the module shipped 12 — the exact ADR-0054 silent-skip they exist to prevent.
   pt-d1's own `parse_content_version` was hardened (word-boundary anchored, must be
   unique, with a decoy tooth); the pre-existing eval is outside this slice's touch set and
   is left for a gate-hardening chore.
10. **`-normal.*` asymmetry once wave 2 lands.** Wave 2 ships normal-map pairs; wave 1 does
    not (D5). After both merge the asset set is inconsistent and `client/art-src/README.md`'s
    inventory lists neither wave. Reconcile with residual 1.
8. `monster-emberkit` does not follow the `monster-<species-slug>` convention this ADR
   establishes; repointing it at Flameling belongs with the wave that replaces placeholder
   sprites for existing forms.
