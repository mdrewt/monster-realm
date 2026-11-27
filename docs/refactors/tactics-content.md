# Tactical content: where each field lives, and one place where a test builds a row

The design record for lpw-27 (harness spec `M-local-play.spec.md`). It decides whether the
tactical battle data stays in registries of its own, keyed by the id of the row each entry
describes, or becomes part of that row; and how a test that needs a content row builds one.
None of it is built. The decision and what it rules out are in `docs/DECISIONS.md` ("Tactical
content is part of the row it describes"). The slices that build it are in section 5.

Every count in this file is measured at commit `26e1e085`. "Production" is Rust outside
`*_tests.rs` files, outside `tests/` directories and outside `#[cfg(test)]` items, in
`game-core/src`, `server-module/src`, `client-wasm/src` and `sim-harness`. A "struct literal" is
an expression `Type { … }`; a return type, a pattern and the declaration are not counted.

## 1. What exists

### 1.1 The registries

`game-core/content/` holds, beside the rows the game had before tactical battles, four
registries whose every entry is keyed by the id of one of those rows:

| Registry | Entries | Keyed by | Describes | Rust type |
| --- | --- | --- | --- | --- |
| `tactics_skills/` | 15 | `skill_id` | a row of `skills/` (15 rows) | `TacticsSkillDef` |
| `tactics_species/` | 20 | `species_id` | a row of `species/` (20 rows) | `TacticsSpeciesDef` |
| `tactics_items/` | 1 | `item_id` | a row of `items/` (5 rows) that has a `cure_status` | `TacticsItemDef` |
| `tactics_zones/` | 2 | `zone_id` | a row of `zones/` (2 rows) | `TacticsZoneDef` |

`battle_maps/` (8 maps) and `tactics_tuning.ron` are not keyed by another row's id. A battle map
is its own thing with its own id, and the tuning is one record. Neither is part of this
question, and both stay as they are under every alternative.

`tactics::content::build_kits` joins the skill and species registries onto `skills/` and
`species/` and returns one `SpeciesTactics` per species; `validate_tactics_items` and
`validate_tactics_zones` check the other two. Twelve variants of `TacticsContentError` exist to
say that the two sides of a join disagree: an entry appears twice, names a row that is not
loaded, or is absent for a row that is (`DuplicateSkillEntry`, `UnknownSkill`,
`MissingSkillEntry`, and the same three for species, items and zones, where the item pair is
named `NotBattleUsable` and `MissingItemEntry`). `cover` is the function that produces them.

The server parses the four registries once per process (`content_cache.rs`: four statics and
four accessors) and passes them, with six more values, to `validate_tactics_content` in a
`TacticsRegistries` of ten fields, from `sync_content` and from `tactics.rs::load_content`.
`client-wasm` loads two of them (`load_tactics_skills`, `load_tactics_species`) to run the same
join. A load-test build generates 100 extra zones, which have no grass and no encounter table,
and a third loader hook (`load_test_zones::tactics_zones!`, `generated_tactics_zones`) generates
a `tactics_zones` entry for each so that the "absent for a row that is loaded" check passes.

### 1.2 Who reads each tactical field

"Reader" is the production code that reads the value after the join. Every field is also read
by the join or the lints in `tactics/content.rs`.

| Field | Registry | Reader |
| --- | --- | --- |
| `tier` | `tactics_skills/` | `kit_skill` (a kit holds one Light and one Heavy); `SkillTactics.tier` prices the action |
| `range_min` | `tactics_skills/` | `SkillGeometry`, read by `tactics::geometry::target_set` |
| `range_max` | `tactics_skills/` | `SkillGeometry`, read by `target_set` |
| `origin` | `tactics_skills/` | `SkillGeometry`, read by `target_set` |
| `shape` | `tactics_skills/` | `SkillGeometry`, read by `target_set` |
| `radius` | `tactics_skills/` | `SkillGeometry`, read by `target_set` |
| `ff_filter` | `tactics_skills/` | `SkillGeometry`, read by `target_set` |
| `movement` | `tactics_species/` | `UnitKit.class`, read by `tactics::movement` |
| `role` | `tactics_species/` | none: it is copied into `SpeciesTactics.role` and nothing reads it |
| `stance` | `tactics_species/` | `server-module/src/tactics.rs`, the stance a wild unit is given |
| `kit` | `tactics_species/` | `build_kits`: the ids of the species' Light and Heavy skill |
| `signature` | `tactics_species/` | none: the join refuses any value but `None`, and every entry holds `None` |
| `footprint` | `tactics_species/` | none: the join refuses any value but `1`, and every entry holds `1` |
| `range` | `tactics_items/` | none: the engine refuses every item action (`ShellHooks::validate_delegated`) |
| `target_filter` | `tactics_items/` | none, for the same reason |
| `pack_weights` | `tactics_zones/` | `start_wild_tactical`, the size of a wild pack |
| `battle_map_pool` | `tactics_zones/` | `start_wild_tactical`, the map a wild battle is fought on |

The key of each entry (`skill_id`, `species_id`, `item_id`, `zone_id`) is not a tactical field.

### 1.3 Struct literals of each carried content type

The five types a tactical field could join, and the struct literals of each in every tracked
`.rs` file:

| Type | Literals | Production | Test | Test literals inside a function that returns the type | Such functions |
| --- | --- | --- | --- | --- | --- |
| `SkillDef` | 50 | 2 | 48 | 29 | 29 |
| `Species` | 16 | 2 | 14 | 12 | 12 |
| `ItemDef` | 10 | 0 | 10 | 8 | 8 |
| `ZoneDef` | 9 | 1 | 8 | 5 | 5 |
| `EncounterTable` | 13 | 2 | 11 | 4 | 4 |

No type has a constructor, so every literal is outside one. The 98 literals sit in 31 files; 58
functions exist only to build one of these types for the tests around them, and each spells
every field. 88 literals are in `game-core` and 10 in `server-module` (6 of those in its tests);
`client-wasm` and `sim-harness` hold none.

Of the 48 test literals of `SkillDef`, 37 are in files of `game-core/src/combat/` and
`game-core/src/monster/` that `docs/refactors/combat-carried-rules.md` edits, and 9 of those are
in files it deletes whole (`combat/ai.rs`, `combat/resolve.rs`, `combat/battle_0hp_tests.rs`).

A test also builds these types from RON text: 39 calls of `parse_skills`, `parse_items`,
`parse_species_parts`, `parse_zones_parts`, `parse_encounters_parts`, `parse_skills_parts` and
`parse_items_parts` in test code, 31 of them in the test module of `game-core/src/content.rs`.
A field that RON must spell breaks those texts as it breaks a literal; a field with a serde
default does not.

### 1.4 Production code that builds a carried struct

| Site | Builds | From | Passes it to |
| --- | --- | --- | --- |
| `tactics/content.rs` `dmg_ref` | `SkillDef` | a `SkillTactics` | `calc_damage`, which reads `power` and `affinity` |
| `tactics/resolve.rs` `skill_def_of` | `SkillDef` | a `SkillTactics` | `calc_damage` |
| `server-module/src/marshal.rs` `species_from_row` | `Species` | a `species_row` row | `game_core::evolve`, which reads `id` and `base_stats` |
| `server-module/src/movement.rs` `join_with_kit` | `Species` | a `species_row` row, with `ability: None` whatever the row holds | `game_core::roll_starter`, which reads `id` and `base_stats` |
| `load_test_zones.rs` `generated_zones` | `ZoneDef` | constants | the zone loader, in a load-test build |
| `server-module/src/marshal.rs` `table_from_encounter_row` | `EncounterTable` | an `encounter` row | `resolve_encounter`, the grass trigger in `movement_tick` |
| `server-module/src/tactics.rs` `start_wild_tactical` | `EncounterTable` | another table, by `..table.clone()` with the rate replaced | `resolve_encounter`, the spawn roll |

Three of the seven build a content struct from a table row. A field a table has no column for
cannot be filled there from the row.

The server reads the same content from two places. A battle reads the embedded registry:
`tactics.rs::content_species` serves the settlement's level-up and reward maths
(`tactics_settle.rs`), and `start_wild_tactical` reads the zone's encounter table and builds
every wild from it. An evolution and the starter grant read `species_row`, and the grass trigger
reads the `encounter` table. The two agree once `sync_content` has run for the build, with one
exception: `sync_content` writes an `encounter` row for every table in the registry and removes
none, so a zone whose encounter table leaves the content keeps its row, the trigger keeps firing
there, and `start_wild_tactical` then refuses each battle because the registry has no table.

### 1.5 The public tables, the wire and the wasm exports today

- `sync_content` builds each content row field by field from the content struct
  (`SpeciesRow { … }`, `SkillRow { … }`, `ItemRow { … }`, `ZoneDefRow { … }`,
  `encounter_rows_from_table`). A struct field with no column is not written: `skill_row` has no
  column for `SkillDef.sets_weather` or `applies_status`, and `item_row` none for
  `essence_affinity` or `essence_amount`.
- `species_row`, `skill_row`, `item_row` and `zone_def` are public. `encounter` is private, has
  no generated client binding, and its one reader is the grass trigger.
- No tactical field is in any table. A client gets tactical content from the same compiled
  registries through `client-wasm`. Its 37 `#[wasm_bindgen]` functions include 18 named
  `tactics_*`, which return the engine's own types (`TacticalUnit`, `UnitKit`, `SkillTactics`,
  `BattleMapDef`, `TacticsTuning` and the like), never a registry entry.
- `CONTENT_VERSION` is 29. The `content-version` eval pins it to a hash of every file under
  `game-core/content/`, so an edit to any content file raises it. `sync_content` then runs its
  write phase once: it writes the species, skill, item, shop, encounter, type-chart and
  evolution rows again, a `zone_def` row only where it differs, and re-derives every `monster`
  and `monster_pub` row from the species' base stats.

## 2. The alternatives

- **A — fixtures, then the fold.** First, each carried struct that is to gain a field gets one
  function that builds a row for a test, and every test literal of that struct becomes a call of
  it, so that a new field is an edit to that function. Then the tactical fields move onto the row
  they describe: a skill's tier and geometry onto `SkillDef`, a species' battler levers and kit
  onto `Species`, an item's reach onto `ItemDef`, and a zone's pack weights and map pool onto
  `ZoneDef` or the encounter table (section 2.1). The four registries, their types' id keys,
  their loaders and caches go, and so do the checks that the two sides of a join agree, except
  the item pair: an item's reach is present exactly when its `cure_status` is, and that stays a
  check. RON must spell the tactical fields of a skill, a species and a zone, so a row without
  them does not parse. The three production sites that build a struct from a table row cannot
  fill a field the table has no column for, so each reads the embedded registry or goes.
- **B — a test-only `Default`, the registries kept.** Each carried struct gets an
  `impl Default` compiled for tests, and a test literal is written `Type { id: 7,
  ..Default::default() }`. The registries, the join and its checks stay as section 1 describes.
  A `#[cfg(test)]` item of `game-core` is not visible to the tests of `server-module`, so the 6
  literals there stay as they are, or the `Default` is compiled into every build, or it sits
  behind a cargo feature those test builds enable. `Affinity`, `StatBlock` and `Level` have no
  `Default`.
- **C — the registries as they are.** Nothing changes in the code. `docs/DECISIONS.md` would
  record a reason for the registries that is about the product, its platform, its players, its
  running cost or law. The entry under review gives none: its reasons are the struct literals a
  new field breaks, and a rule that expired when the 1v1 system was retired.

### 2.1 Under A, where a zone's two fields go

`pack_weights` and `battle_map_pool` have one reader, `start_wild_tactical`, which reads the
zone's encounter table from the same embedded registry in the same call.

- **Z0 — the encounter row, with new columns.** Both fields join `EncounterTable`, and the
  `encounter` table gains a column for each at the second schema consolidation (lpw-33) so that
  `table_from_encounter_row` can fill them. Until then `tactics_zones/` stays. The grass trigger,
  the one reader of the table, reads neither field.
- **Z1 — `ZoneDef`.** Both fields join `ZoneDef`. No table changes: `zone_def` gets no column,
  and nothing builds a `ZoneDef` from a row. Every zone carries the two fields, as every zone has
  a `tactics_zones` entry today, whether or not it has an encounter table, and `generated_zones`
  copies zone 0's for each load-test zone. `ZoneDef` is the struct the public `zone_def` table
  mirrors, while the rest of a zone's spawn data sits in the private `encounter` table. The
  trigger and the start still read two sources.
- **Z2 — `EncounterTable`, read from the registry.** Both fields join `EncounterTable`. The grass
  trigger reads the encounter table from the embedded registry, as `start_wild_tactical` does, so
  one source decides whether an encounter fires and what it holds; `table_from_encounter_row`
  goes; nothing reads the `encounter` table, and lpw-33 removes it. A zone with no wild
  encounters carries neither field, so the load-test hook goes too. The server's tick tests,
  which seed an `encounter` row to make a grass step roll or not roll an encounter, lose that way
  in.

## 3. The judge's scores

A `judge` scored A, B and C, and Z0, Z1 and Z2, from sections 1 and 2 and the code, without
sections 4 to 6 and without being told which the author preferred. The rubric was fixed before
scoring. Five criteria, each scored 0 to 10 and weighted, total 100:

1. **Authoring a row** (weight 2.5). How many places an author edits to add or retune a skill, a
   species, an item or a zone, and what a mistake costs: where it is refused and how the refusal
   names it.
2. **What the rule layer carries** (weight 2). Code and types that exist to connect data to
   itself; states the types allow that the content forbids.
3. **Risk to a running world** (weight 2). Schema, wire format, generated bindings, what a
   database that holds players goes through at the publish, and whether the client and the
   server can come to compute different answers.
4. **The road there** (weight 1.5). How long the code sits in a half-state, whether each step
   leaves `master` coherent and can be reverted alone. The effort of editing tests is not scored
   (`standards/decisions.md`).
5. **The next tactical field** (weight 2). What the weather wave, a signature skill, a footprint
   above 1 and the item rule each cost under the alternative, in the product code and in every
   place that builds a row.

Ties within 3 points are broken by criterion 3, then by the fewer slices. Neither result is
within 3 points.

### 3.1 Sidecars or the fold

| Criterion | Weight | A | B | C |
| --- | --- | --- | --- | --- |
| 1. Authoring a row | 2.5 | 9 | 6 | 6 |
| 2. What the rule layer carries | 2 | 8 | 3 | 4 |
| 3. Risk to a running world | 2 | 8 | 10 | 10 |
| 4. The road there | 1.5 | 6 | 9 | 10 |
| 5. The next tactical field | 2 | 8 | 6 | 6 |
| Total | | 79.5 | 66.5 | 70 |

- **A (79.5, first).** A skill or a species is authored in one row. A missing field is a parse
  error that names the file. Four sidecar types, the join's "two sides disagree" variants,
  `cover`, the ten-field registry struct, four cache statics and a load-test hook go. It loses
  points for the item check that stays, and for the content-version reseed and the several
  slices on the way.
- **B (66.5).** It has no effect on the product. A `Default` compiled into every build allows a
  content row that cannot exist (`id` 0, an empty name); behind a feature it adds cargo
  machinery; either way the next tactical field still goes to a registry of its own.
- **C (70).** It costs and risks nothing, and every tactical change keeps paying for the join:
  two files per row, the join and its copy, and a client that loads two more registries.

The judge looked for a reason for C that is about the product, its platform, its players, its
running cost or law, and found none. The one reason in the entry that is not about tests is the
`encounter` round trip, which is Z0's cost and no other alternative's. Keeping secret data from
public data does not apply: the tactical data already ships to the client inside the wasm
module. Running cost and wasm size differ negligibly.

**What would overturn it.** A would lose to C if the fold put placeholder tactical values into
a `Species` or a `SkillDef` that production code builds; section 4.4 gives each such site a
complete row or removes it. A would also lose to a product reason for separate registries, such
as tactical data that ships apart from the rows it describes.

### 3.2 Where a zone's two fields go

| Criterion | Weight | Z0 | Z1 | Z2 |
| --- | --- | --- | --- | --- |
| 1. Authoring a row | 2.5 | 5 | 7 | 9 |
| 2. What the rule layer carries | 2 | 3 | 6 | 9 |
| 3. Risk to a running world | 2 | 5 | 9 | 8 |
| 4. The road there | 1.5 | 3 | 9 | 7 |
| 5. The next tactical field | 2 | 2 | 8 | 8 |
| Total | | 37 | 77 | 83 |

- **Z0 (37).** `tactics_zones/` stays until lpw-33, every later zone field needs a column that
  only a consolidation can add, and the trigger and the start keep reading two sources.
- **Z1 (77).** No schema change, in one slice. Every zone, a town with no wild encounters
  included, authors a pack and a map pool that nothing reads there; the fields sit beside a
  public table's struct; the load-test hook copies zone 0; two sources stay.
- **Z2 (83, first).** The rate, the entries, the pack and the map pool of a wild battle sit in
  one row. A zone without encounters cannot carry them. `table_from_encounter_row` and the third
  hook go, and the trigger and the start read one source. Its risk is that it changes what
  `movement_tick` reads, and that the table sits unread until lpw-33 removes it.

The judge gave no weight to the tick tests losing their seeded row, as the rubric directs.

**What would overturn it.** Z1 would come first if a battle that is not a wild encounter needed
a map pool for a zone with no encounter table (the game design names none), or if reading the
registry in the trigger were unsafe for a running world. Section 4.5 answers the second.

### 3.3 The judge's check of sections 1 and 2

The judge checked the counts of 1.1, all of 1.2, the per-type counts of 1.3 by its own search,
every row of 1.4 and every bullet of 1.5 against the sources. It found two statements false or
misleading and six incomplete. The sections above state the corrected facts: 58 functions (not
55) build a carried type for tests; a content-version rise also re-derives every monster row;
the item check survives the fold; the fold must say what replaces the production builders;
`StatBlock` has no `Default`; the entry under review records no product reason; Z2 removes the
load-test hook and ends the two-source read; Z1 puts spawn data on the struct a public table
mirrors.

## 4. The chosen design

A, with Z2. The tactical fields become part of the rows they describe, and a wild battle's
pack weights and map pool become part of the zone's encounter table.

### 4.1 One place where a test builds a row

`game-core/src/fixtures.rs` holds one function for each carried struct that gains a field. It
is compiled for `game-core`'s own tests and for a crate that enables `game-core`'s `fixtures`
feature, which `server-module` does in its `[dev-dependencies]` and no crate does in
`[dependencies]`. No production code calls it, and a release build does not contain it.

| Function | Returns | The caller chooses | The function fills |
| --- | --- | --- | --- |
| `fixtures::skill(id, affinity, power, accuracy)` | `SkillDef` | identity and the three values the damage and accuracy rules read | a name, `pp`, no weather, no status, and from section 5's line 5 a Light single-target melee `tactics` block |
| `fixtures::species(id, affinity, base_stats)` | `Species` | identity, type and base stats | a name, no learnable skill, no ability, tier 0, and from line 6 a `tactics` block |
| `fixtures::item(id)` | `ItemDef` | identity | every other field at the value an item with no function has |
| `fixtures::encounter_table(zone_id, encounter_rate, entries)` | `EncounterTable` | the three fields the struct has today | from line 8, `PackWeights::DEFAULT` and an empty map pool |

A test that needs another value writes it over the fixture with struct-update syntax:
`SkillDef { applies_status: Some(StatusKind::Burn), ..fixtures::skill(1, Affinity::Fire, 40, 100) }`.
A new field on a carried struct is then an edit to one function, and a test that asserts on the
field sets it. `ZoneDef` gains no field under Z2 and gets no fixture.

The 58 per-file functions of section 1.3 either call the fixture or go. The RON texts of
section 1.3 are not helped by a fixture: each fold line edits the texts of its own type once.

### 4.2 The home of each tactical field

| Field | Home | RON |
| --- | --- | --- |
| `tier` | `SkillDef.tactics.tier` | required |
| `range_min` | `SkillDef.tactics.range_min` | required |
| `range_max` | `SkillDef.tactics.range_max` | required |
| `origin` | `SkillDef.tactics.origin` | required |
| `shape` | `SkillDef.tactics.shape` | required |
| `radius` | `SkillDef.tactics.radius` | required |
| `ff_filter` | `SkillDef.tactics.ff_filter` | required |
| `movement` | `Species.tactics.movement` | required |
| `role` | `Species.tactics.role` | required |
| `stance` | `Species.tactics.stance` | required |
| `kit` | `Species.tactics.kit` | required |
| `signature` | none: removed | not accepted |
| `footprint` | none: removed | not accepted |
| `range` | `ItemDef.battle_use.range` | absent for an item with no `cure_status` |
| `target_filter` | `ItemDef.battle_use.target_filter` | absent for an item with no `cure_status` |
| `pack_weights` | `EncounterTable.pack_weights` | required |
| `battle_map_pool` | `EncounterTable.battle_map_pool` | required |

- `SkillDef.tactics` is a `TacticsSkillDef` and `Species.tactics` a `TacticsSpeciesDef`: the
  types the registries hold today, without the id key. Each keeps `deny_unknown_fields`, so a
  misspelt lever is a parse error that names the file. A skills row reads
  `(id: 2, name: "Fire Fang", affinity: Fire, power: 70, accuracy: 95, pp: 15, tactics: (tier: Heavy, range_min: 1, range_max: 1, origin: TargetUnit, shape: Single, radius: 0, ff_filter: Enemies))`.
- `ItemDef.battle_use` is an `Option<TacticsItemDef>` with a serde default of `None`.
  `validate_tactics_items` keeps one rule and its two variants: an item has a `battle_use`
  exactly when it has a `cure_status` (`NotBattleUsable`, `MissingItemEntry`). The two fields
  have no reader; the slice that builds the item rule gives them one and decides then whether
  the effect and the reach become one value.
- `role` moves although nothing reads it: it holds an authored value for each of the 20 species,
  and the battle HUD's unit detail is designed to show it. `signature` and `footprint` hold the
  same value in every entry and carry no information, so they do not move. `DormantLever` goes
  with them. The wave that gives one a reader adds the field then, which costs an edit to the
  struct, to the fixture and to the rows that set it.
- `EncounterTable` gains the two fields directly. The `encounter` row keeps its three columns:
  `encounter_rows_from_table` goes on writing the zone, the rate and the entries until lpw-33
  removes the table.
- `SkillTactics`, `UnitKit` and `SpeciesTactics` keep their fields. They are the engine's view
  of a skill and a battler, and `client-wasm` serialises them. `build_kits(species, skills)`
  still returns one `SpeciesTactics` per species, and still refuses a kit whose skill is not
  loaded or has the wrong tier (`KitTier`), which is a reference between two rows and not a
  join of two halves of one.

### 4.3 What the fold changes

| Surface | Change |
| --- | --- |
| `CONTENT_VERSION` | Rises by one in each of lines 5 to 8, the four that edit `game-core/content/`: from 29 to 33 if nothing else raises it between. Each regenerates `evals/baselines/content-hash.json`. Lines 1 to 4 do not touch it. |
| A database that holds players | At the publish after each rise, the owner's `sync_content` runs its write phase once (section 1.5). Every value it writes equals the value it replaces: no fold line changes a field a table holds, a base stat, or a value the engine reads. |
| `species_row` | No column added, removed or re-typed. |
| `skill_row` | No column added, removed or re-typed. |
| `item_row` | No column added, removed or re-typed. `cure_status` stays a field of `ItemDef` and a column. |
| `zone_def` | No column added, removed or re-typed. `ZoneDef` does not change. |
| `encounter` | No column added, removed or re-typed. After line 3 nothing reads it. lpw-33 removes the table with `EncounterRow`, `EncounterEntryRow`, `encounter_rows_from_table`, the loop in `sync_content` that writes it and its entry in `DATA_LIFECYCLE_MANIFEST`. |
| Generated bindings, `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL`, `evals/baselines/table-schemas.json` | Unchanged by lines 1 to 8. `encounter` is private and has no binding, so its removal at lpw-33 changes the schema baseline and no binding. |
| `client-wasm` exports | None of the 37 changes its name, its arguments or the shape of its result. `load_tactics_content` calls `build_kits(&species, &skills)` and stops loading two registries. The module's bytes change with the content it embeds. |
| `game-core` API | `build_kits` takes two slices. `TacticsRegistries` holds `species`, `skills`, `items`, `encounters`, `battle_maps` and `tuning`. `load_tactics_skills`, `load_tactics_species`, `load_tactics_items`, `load_tactics_zones`, `TacticsZoneDef`, `cover` and eleven variants of `TacticsContentError` go: the nine "two sides disagree" variants for skills, species and zones, `DuplicateItemEntry` and `DormantLever`. |
| `game-core/build.rs` | Its registry list goes from eighteen directories to fourteen. |
| `server-module/src/content_cache.rs` | The four statics and four accessors of section 1.1 go. |
| `load_test_zones` | `tactics_zones!` and `generated_tactics_zones` go; a load-test zone has no encounter table and needs nothing. |

### 4.4 Production code that builds a carried struct, after the fold

| Site | After |
| --- | --- |
| `dmg_ref`, `skill_def_of` | Each fills `tactics` from the `SkillTactics` it is given, which holds the tier and the geometry. No value is invented. |
| `species_from_row` | Goes. `apply_evolution` takes the target species from `tactics::content_species`, the registry the settlement already reads. |
| `join_with_kit` | Takes the starter species from `content_species`. The row it passes then carries the species' real ability where the literal carried `None`; `roll_starter` reads neither. |
| `generated_zones` | Unchanged: `ZoneDef` gains no field. |
| `table_from_encounter_row` | Goes. The grass trigger takes the zone's table from the registry (`TacticsContent::encounter`). |
| `start_wild_tactical` | Unchanged: `..table.clone()` copies the new fields. |

`apply_evolution` and `join_with_kit` then fail when the registry fails to load, as a battle
start does; `sync_content` refuses such a build's content first.

`calc_damage` keeps taking a `&SkillDef`. Narrowing it to the two values it reads would remove
`skill_def_of` and the literal in `dmg_ref`, at the price of a new signature for a rule the
client and the server share and of 29 call sites, most of them in tests the combat plan is
removing. The fold does not need it, so this design does not ask for it.

### 4.5 The grass trigger reads the registry

`movement_tick` asks `content()` for the zone's encounter table where it reads the `encounter`
row today.

- **One source.** The trigger and `start_wild_tactical` then read the same table in the same
  transaction, so a zone whose table left the content stops triggering (section 1.4's stale
  row), and no publish leaves the two disagreeing until `sync_content` runs.
- **A registry that fails to load.** `content()` caches the result of loading and validating the
  tactical content. If it is an error, every grass step is a no-op that writes one rate-limited
  log line, where today the trigger fires and `start_wild_tactical` fails on the same error and
  logs it. `sync_content` validates the same content before it writes, so a build whose content
  is invalid is refused there first.
- **Cost.** A step onto grass does one lookup in a parsed list where it does an index read and
  rebuilds a `Vec` of entries today.
- **What the tick tests drive.** A test can no longer replace zone 0's table. The rules "a rate
  of 0 never fires" and "a band above the lead's level never fires" are `game-core`'s
  (`resolve_encounter`) and are tested there. The shell keeps a test that a grass step which
  fires starts a tactical battle, on zone 0's shipped table (its numbers are frozen by the
  recruit e2e) at a timestamp whose roll fires: a reducer's randomness is seeded from its
  timestamp, which the test sets.
- **Privacy.** The `encounter` table stays private while it exists. Nothing in this design puts
  spawn data in a public table.

## 5. The slices that build it

Each line is one slice and merges alone. Lines 1 and 4 move test scaffolding and are a
tester's edit from end to end; their proof is the suites passing with every assertion as it is
(`standards/testing-tdd.md`, "Behavior-preserving changes"). Lines 5 to 8 are the fold. Each
of them starts with a characterization test, written by a tester before the first production
edit, that holds as literals the values the engine reads from the shipped content (the 20
joined kits for lines 5 and 6, the item entry for line 7, the two zones' pack weights and pools
for line 8); it stays green through the move. The slice for a line deletes that line; line 8 deletes this file and brings
`ARCHITECTURE.md` and the decision entry in line with what is built.

| Line | Slice | After | Kind |
| --- | --- | --- | --- |
| 1 | tc-1 | nothing | refactor |
| 2 | tc-2 | nothing | feature |
| 3 | tc-3 | nothing | feature |
| 4 | tc-4 | tc-1, tc-2, tc-3 | refactor |
| 5 | tc-5 | tc-1 | refactor |
| 6 | tc-6 | tc-4, tc-5 | refactor |
| 7 | tc-7 | tc-4 | refactor |
| 8 | tc-8 | tc-3, tc-4, tc-6, tc-7 | refactor |

1. **tc-1 — a test builds a skill in one place.** Adds `game-core/src/fixtures.rs` with
   `fixtures::skill`, the `fixtures` feature of `game-core`, and the feature on `server-module`'s
   dev-dependency. The 48 test literals of `SkillDef` in 12 files become calls of it. It shows
   that a release build of the module and of `client-wasm` has the feature off. It edits test
   files that lines 3 to 8 of `docs/refactors/combat-carried-rules.md` also edit, so it is not
   built at the same time as one of them; whichever lands second converts what the first left.
2. **tc-2 — a reducer takes a species from the content registry.** `apply_evolution` and
   `join_with_kit` call `tactics::content_species`. `species_from_row` goes with its tests.
3. **tc-3 — the grass trigger reads the content registry.** Section 4.5.
   `table_from_encounter_row` goes with its tests. The tick tests that seed an `encounter` row
   are rewritten as section 4.5 says.
4. **tc-4 — a test builds a species, an item and an encounter table in one place.** Adds
   `fixtures::species`, `fixtures::item` and `fixtures::encounter_table`. The test literals of
   `Species`, `ItemDef` and `EncounterTable` that tc-2 and tc-3 left become calls of them.
5. **tc-5 — a skill's tier and geometry join its row.** `SkillDef.tactics`; the 15 entries of
   `tactics_skills/` move into `skills/`; `TacticsSkillDef` loses `skill_id`;
   `build_kits` loses its `tactics_skills` argument; `load_tactics_skills`,
   `DuplicateSkillEntry`, `UnknownSkill`, `MissingSkillEntry`, the server's cache of the registry
   and `client-wasm`'s load of it go. `CONTENT_VERSION` rises.
6. **tc-6 — a species' battler levers and kit join its row.** `Species.tactics`; the 20
   entries of `tactics_species/` move into `species/` without `signature` and `footprint`;
   `TacticsSpeciesDef` loses `species_id` and those two fields; `build_kits` takes two slices;
   `load_tactics_species`, `DuplicateSpeciesEntry`, `UnknownSpecies`, `MissingSpeciesEntry`,
   `DormantLever`, the server's cache and `client-wasm`'s load go. `CONTENT_VERSION` rises.
7. **tc-7 — a battle item's reach joins its row.** `ItemDef.battle_use`; the one entry of
   `tactics_items/` moves into `items/`; `TacticsItemDef` loses `item_id`;
   `load_tactics_items`, `DuplicateItemEntry` and the server's cache go. `CONTENT_VERSION` rises.
8. **tc-8 — a zone's pack weights and battle maps join its encounter table.**
   `EncounterTable.pack_weights` and `battle_map_pool`; the two entries of `tactics_zones/` move
   into `encounters/`; `validate_tactics_zones` checks the encounter tables against the maps;
   `TacticsZoneDef`, `load_tactics_zones`, `DuplicateZoneEntry`, `UnknownZone`,
   `MissingZoneEntry`, `cover`, the server's cache, `load_test_zones::tactics_zones!` and
   `generated_tactics_zones` go. `TacticsRegistries` takes the shape of section 4.3.
   `CONTENT_VERSION` rises.

lpw-33 then removes the `encounter` table (section 4.3). Until it does, the table is written at
every content sync and read by nothing.

## 6. What this rules out

- A registry whose entries are keyed by the id of a row in another registry and describe that
  row. A value that describes a skill, a species, an item or a zone's encounters is a field of
  that row.
- A tactical field that RON may omit for a skill, a species or an encounter table. A row
  without it does not parse, so no check has to find the gap.
- A content struct built from a table row. A reducer that needs content reads the embedded
  registry; the content tables are what a client reads.
- A fixture called from production code, or compiled into a release build.
- A field with one value in every row and no reader. It is added when a rule reads it.
- A column on a content table for a field only the engine reads.
