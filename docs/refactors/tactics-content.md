# Tactical content: where each field lives, and one place where a row is built

The design record for lpw-27 (harness spec `M-local-play.spec.md`). It decides whether the
tactical battle data stays in registries of its own, keyed by the id of the row each entry
describes, or becomes part of that row; and how code that needs a content row for a test or a
calculation builds one. None of it is built.

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
join. A load-test build generates 100 extra zones, and a third loader hook
(`load_test_zones::tactics_zones!`, `generated_tactics_zones`) generates a `tactics_zones` entry
for each so that the "absent for a row that is loaded" check passes.

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
| `signature` | `tactics_species/` | none: the join refuses any value but `None` |
| `footprint` | `tactics_species/` | none: the join refuses any value but `1` |
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
| `SkillDef` | 50 | 2 | 48 | 29 | 26 |
| `Species` | 16 | 2 | 14 | 12 | 12 |
| `ItemDef` | 10 | 0 | 10 | 8 | 8 |
| `ZoneDef` | 9 | 1 | 8 | 5 | 5 |
| `EncounterTable` | 13 | 2 | 11 | 4 | 4 |

No type has a constructor, so every literal is outside one. The 98 literals sit in 31 files; 55
functions exist only to build one of these types for the tests of one file, and each spells
every field. 88 literals are in `game-core` and 10 in `server-module` (6 of those in its tests);
`client-wasm` and `sim-harness` hold none.

Of the 48 test literals of `SkillDef`, 37 are in files of `game-core/src/combat/` and
`game-core/src/monster/` that `docs/refactors/combat-carried-rules.md` edits, and 9 of those are
in files it deletes whole (`combat/ai.rs`, `combat/resolve.rs`, `combat/battle_0hp_tests.rs`).

A test also builds these types from RON text: 39 calls of `parse_skills`, `parse_items`,
`parse_species_parts`, `parse_zones_parts`, `parse_encounters_parts`, `parse_skills_parts` and
`parse_items_parts` in test code, 31 of them in the test module of `game-core/src/content.rs`. A field that
RON must spell breaks those texts as it breaks a literal; a field with a serde default does not.

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
cannot be filled there from the row. The server already reads species from the embedded registry
for a battle: `tactics.rs::content_species` serves the settlement's level-up and reward maths
(`tactics_settle.rs`), and `start_wild_tactical` builds every wild from it.

### 1.5 The public tables, the wire and the wasm exports today

- `sync_content` builds each content row field by field from the content struct
  (`SpeciesRow { … }`, `SkillRow { … }`, `ItemRow { … }`, `ZoneDefRow { … }`,
  `encounter_rows_from_table`). A struct field with no column is not written: `skill_row` has no
  column for `SkillDef.sets_weather` or `applies_status`, and `item_row` none for
  `essence_affinity` or `essence_amount`.
- `species_row`, `skill_row`, `item_row` and `zone_def` are public. `encounter` is private; its
  one reader is the grass trigger.
- No tactical field is in any table. A client gets tactical content from the same compiled
  registries through `client-wasm`, whose 18 `tactics_*` exports return the engine's own types
  (`TacticalUnit`, `UnitKit`, `SkillTactics`, `BattleMapDef`, `TacticsTuning` and the like),
  never a registry entry.
- `CONTENT_VERSION` is 29. The `content-version` eval pins it to a hash of every file under
  `game-core/content/`, so an edit to any content file raises it, and `sync_content` then
  rewrites every content row.

## 2. The alternatives

- **A — constructors, then the fold.** First, each carried struct that is to gain a field gets
  one constructor, and every literal of that struct becomes a call of it, so that a new field is
  an edit to the constructor. Then the tactical fields move onto the row they describe: a skill's
  tier and geometry onto `SkillDef`, a species' battler levers and kit onto `Species`, an item's
  reach onto `ItemDef`, and a zone's pack weights and map pool onto `ZoneDef` or the encounter
  table (section 2.1). The four registries, their types' id keys, their loaders and caches, and
  the checks that the two sides of a join agree go. RON must spell the tactical fields of a skill,
  a species and a zone, so a row without them does not parse.
- **B — a test-only `Default`, the registries kept.** Each carried struct gets an
  `impl Default` compiled for tests, and a test literal is written `Type { id: 7,
  ..Default::default() }`. The registries, the join and its checks stay as section 1 describes.
  A `#[cfg(test)]` item of `game-core` is not visible to the tests of `server-module`, so the 6
  literals there stay as they are, or the `Default` is compiled into
  every build, or it sits behind a cargo feature those test builds enable. `Affinity` and `Level`
  have no `Default`.
- **C — the registries as they are.** Nothing changes in the code. `docs/DECISIONS.md` records a
  reason for the registries that is about the product, its platform, its players, its running
  cost or law.

### 2.1 Under A, where a zone's two fields go

`pack_weights` and `battle_map_pool` have one reader, `start_wild_tactical`, which reads the
zone's encounter table from the same embedded registry in the same call.

- **Z0 — the encounter row, with new columns.** Both fields join `EncounterTable`, and the
  `encounter` table gains a column for each at the second schema consolidation (lpw-33) so that
  `table_from_encounter_row` can fill them. Until then `tactics_zones/` stays. The grass trigger,
  the one reader of the table, reads neither field.
- **Z1 — `ZoneDef`.** Both fields join `ZoneDef`. No table changes: `zone_def` gets no column,
  and nothing builds a `ZoneDef` from a row. Every zone carries the two fields, as every zone has
  a `tactics_zones` entry today, whether or not it has an encounter table. A load-test zone copies
  zone 0's.
- **Z2 — `EncounterTable`, read from the registry.** Both fields join `EncounterTable`. The grass
  trigger reads the encounter table from the embedded registry, as `start_wild_tactical` does;
  `table_from_encounter_row` goes; nothing reads the `encounter` table, and lpw-33 removes it. A
  zone with no wild encounters carries neither field. The server's tick tests, which seed an
  `encounter` row to make a grass step roll or not roll an encounter, lose that way in.

## 3. The judge's scores

A `judge` scored A, B and C, and Z0, Z1 and Z2, from sections 1 and 2 and the code, without
sections 4 to 6. The rubric was fixed before scoring. Five criteria, each scored 0 to 10 and
weighted, total 100:

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

Ties within 3 points are broken by criterion 3, then by the fewer slices.
