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
every wild from it. An evolution, the starter grant, training and the battle write-back's XP
maths read `species_row`, and the grass trigger reads the `encounter` table. The two agree
once `sync_content` has run for the build, with one exception: `sync_content` writes an
`encounter` row for every table in the registry and removes none, so a zone whose encounter
table leaves the content keeps its row, the trigger keeps firing there, and
`start_wild_tactical` then refuses each battle because the registry has no table.

### 1.5 The public tables, the wire and the wasm exports today

- `sync_content` builds each content row field by field from the content struct
  (`SpeciesRow { … }`, `SkillRow { … }`, `ItemRow { … }`, `ZoneDefRow { … }`,
  `encounter_rows_from_table`). A struct field with no column is not written: `skill_row` has no
  column for `SkillDef.sets_weather` or `applies_status`, and `item_row` none for
  `essence_affinity` or `essence_amount`.
- `species_row`, `skill_row`, `item_row` and `zone_def` are public. `encounter` is private: no
  client can subscribe to it, the generated bindings declare its two row types
  (`EncounterRow`, `EncounterEntryRow`), and its one reader is the grass trigger. About ten
  server tests seed a row of it to make a grass step roll or not roll an encounter
  (`movement_tests.rs` `bt16_world`, `tactics_tests.rs` `npd_always_firing`).
- No tactical field is in any table. A client gets tactical content from the same compiled
  registries through `client-wasm`. Its 37 `#[wasm_bindgen]` functions include 18 named
  `tactics_*`, which return the engine's own types (`TacticalUnit`, `UnitKit`, `SkillTactics`,
  `BattleMapDef`, `TacticsTuning` and the like), never a registry entry.
- `CONTENT_VERSION` is 29. The `content-version` eval pins it to a hash of every file under
  `game-core/content/`, so an edit to any content file raises it. `sync_content` then runs its
  write phase once: it writes the species, skill, item, shop, encounter, type-chart and
  evolution rows again, a `zone_def` row only where it differs, and re-derives every `monster`
  and `monster_pub` row from the species' base stats. A tactical battle in progress is closed
  at its next load after the publish (`tactics.rs::load` refuses a battle stamped with another
  content version): as fled, with each unit's HP written back, the faint penalty applied and
  no reward paid. Every content edit costs this, once per publish however many rises the
  publish carries.

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
  them does not parse. The production sites that build a struct from a table row cannot fill a
  field the table has no column for. The rules they call read one or two values of the struct
  (section 1.4), so those rules take the values and the sites pass them from the row as they
  do today; no reducer changes which data it reads, and no placeholder is written.
- **B — a test-only `Default`, the registries kept.** Each carried struct gets an
  `impl Default` compiled for tests, and a test literal is written `Type { id: 7,
  ..Default::default() }`. The registries, the join and its checks stay as section 1 describes.
  A `#[cfg(test)]` item of `game-core` is not visible to the tests of `server-module`, so the 6
  literals there stay as they are, or the `Default` is compiled into every build, or it sits
  behind a cargo feature those test builds enable. `Affinity`, `StatBlock` and `Level` have no
  `Default`.
- **C — the registries as they are.** Nothing changes in the code. `docs/DECISIONS.md` would
  record a reason for the registries that is about the product, its platform, its players, its
  running cost or law. None is on record (section 3.1).

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
  mirrors, while the rest of a zone's spawn data sits in the private `encounter` table.
- **Z2 — `EncounterTable`, read from the registry.** Both fields join `EncounterTable`. The grass
  trigger reads the encounter table from the embedded registry, as `start_wild_tactical` does, so
  one source decides whether an encounter fires and what it holds, and the stale row of section
  1.4 stops mattering; `table_from_encounter_row` goes; nothing reads the `encounter` table, and
  that consolidation removes it, which changes the generated bindings and both schema baselines.
  A zone with
  no wild encounters carries neither field, so the load-test hook goes too. The tests of
  section 1.5 cannot seed a row under Z2: the tick needs a parameter through which it is handed
  its table, or each test a timestamp whose roll fires on zone 0's shipped rate.
  `tactics.rs::content()` does not run `validate_encounters`, and it answers "this zone has no
  table" and "the content failed to load" with the same error type.
- **Z3 — `EncounterTable`, with the trigger and its table as they are.** Both fields join
  `EncounterTable`, as in Z2, and the load-test hook goes. The grass trigger keeps reading the
  private `encounter` row. `resolve_encounter` reads only a table's rate and entries and
  `roll_encounter` only its entries, so each takes what it reads, and the server builds no
  `EncounterTable` from the row. The `encounter` table keeps its three columns and its one
  reader; no schema, binding or baseline changes, now or at the consolidation, and every test
  keeps the row
  it seeds. The trigger and the start keep reading two sources, and the stale row of section 1.4
  stays until `sync_content` removes such rows.

## 3. The judge's scores

A `judge` scored the alternatives from sections 1 and 2 and the code, without sections 4 to 6
and without being told which the author preferred. The rubric was set before the first
scoring. Five
criteria, each scored 0 to 10 and weighted, total 100:

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
   (`standards/decisions.md`); whether a behaviour can still be checked at all is.
5. **The next tactical field** (weight 2). What the weather wave, a signature skill, a footprint
   above 1 and the item rule each cost under the alternative, in the product code and in every
   place that builds a row.

Ties within 3 points are broken by criterion 3, then by the fewer slices. Neither result is
within 3 points.

The judge scored twice. The first scoring had A, B and C, and Z0, Z1 and Z2. A `reviewer` and a
`red-team` then read a design built on its result (A with Z2, and reducers reading species from
the registry) and found the facts that sections 1.5 and 2.1 now state about Z2, that a
content-version rise closes battles in progress, and that reading species from the registry
would have opened a window in which an evolution and a training session disagree. Z3 and the
"rules take the values they read" form of A came out of those findings. The judge checked the
new facts against the code and scored again; the tables are the second scoring.

### 3.1 Sidecars or the fold

| Criterion | Weight | A | B | C |
| --- | --- | --- | --- | --- |
| 1. Authoring a row | 2.5 | 9 | 6 | 6 |
| 2. What the rule layer carries | 2 | 9 | 3 | 4 |
| 3. Risk to a running world | 2 | 8 | 10 | 10 |
| 4. The road there | 1.5 | 6 | 9 | 10 |
| 5. The next tactical field | 2 | 8 | 6 | 6 |
| Total | | 81.5 | 66.5 | 70 |

- **A (81.5, first).** A skill or a species is authored in one row. A missing field is a parse
  error that names the file. The four id keys, `TacticsZoneDef`, the join's "two sides
  disagree" variants, `cover`, four fields of the registry struct, four cache statics and a
  load-test hook go, and no reducer changes what it reads. Its cost to a running world is that
  of any content edit: a reseed with the same values and the close of battles in progress
  (section 1.5), once per publish. It loses
  points for the item check that stays, the two dormant species levers, and the several slices
  on the way. In the first scoring A had 79.5, with criterion 2 at 8.
- **B (66.5).** It has no effect on the product. A `Default` compiled into every build allows a
  content row that cannot exist (`id` 0, an empty name); behind a feature it adds cargo
  machinery; either way the next tactical field still goes to a registry of its own.
- **C (70).** It costs and risks nothing, and every tactical change keeps paying for the join:
  two files per row, the join and its copy, and a client that loads two more registries.

The judge looked for a reason for C that is about the product, its platform, its players, its
running cost or law, and found none. The one reason in the entry that was not about tests is
the `encounter` round trip, which is Z0's cost and no other alternative's. Keeping secret data
from public data does not apply: the tactical data already ships to the client inside the wasm
module. Running cost and wasm size differ negligibly. The close of battles in progress is the
cost of any content edit, not of the fold.

**What would overturn it.** A would lose to C if the fold put placeholder tactical values into
a `Species` or a `SkillDef` that production code builds (section 4.4 leaves none), or if its
content edits could not share one publish in a world whose players hold ranked battles. A would
also lose to a product reason for separate registries, such as tactical data that ships apart
from the rows it describes.

### 3.2 Where a zone's two fields go

| Criterion | Weight | Z0 | Z1 | Z2 | Z3 |
| --- | --- | --- | --- | --- | --- |
| 1. Authoring a row | 2.5 | 5 | 7 | 9 | 9 |
| 2. What the rule layer carries | 2 | 3 | 6 | 8 | 8 |
| 3. Risk to a running world | 2 | 5 | 9 | 7 | 9 |
| 4. The road there | 1.5 | 3 | 9 | 7 | 9 |
| 5. The next tactical field | 2 | 2 | 8 | 8 | 8 |
| Total | | 37 | 77 | 79 | 86 |

- **Z0 (37).** `tactics_zones/` stays until the consolidation, every later zone field needs a
  column that
  only a consolidation can add, and it adds marshaling in both directions.
- **Z1 (77).** No schema change, in one slice. Every zone, a town with no wild encounters
  included, authors a pack and a map pool that nothing reads there; the fields sit beside a
  public table's struct; the load-test hook survives in another form.
- **Z2 (79).** One source for the trigger and the start, and the stale row stops mattering. It
  needs a parameter on the tick so that the tick can be checked at all, an error type that tells
  "no table" from "the content failed to load", and `validate_encounters` in `content()`; it
  changes what the busiest reducer reads; and the table sits dead until the consolidation. In
  the first
  scoring, without those facts, Z2 had 83 and came first.
- **Z3 (86, first).** The same row to author as Z2: a zone with no encounters carries nothing,
  and the load-test hook goes. The rules take the values they read, so no `EncounterTable` is
  built from a row. Nothing changes in the schema, the bindings, what a reducer reads or what a
  test can check, and it waits on nothing. Against it: two copies of the truth remain, and the
  stale row stays until `sync_content` removes such rows.

**What would overturn it.** Z1 would come first if a battle that is not a wild encounter needed
a map pool for a zone with no encounter table; the game design names none. Z2 would need a
fault a player sees from the two copies that no change to `sync_content` can close.

### 3.3 The judge's checks of sections 1 and 2

The judge checked the counts of 1.1, all of 1.2, the per-type counts of 1.3 by its own search,
every row of 1.4 and every bullet of 1.5 against the sources, and then the new facts. The
sections above state what it corrected or added: 58 functions (not 55) build a carried type for
tests; a content-version rise also re-derives every monster row, and closes a battle at its
next load after the publish and not at the publish; the item check survives the fold;
`StatBlock` has no `Default`; the entry under review recorded no product reason; Z1 puts spawn
data on the struct a public table mirrors; under Z3 the conversion of a row's entries stays
fallible (`Level::new`), so the tick keeps its `encounter_table_error` path.

## 4. The chosen design

A, with Z3. The tactical fields become part of the rows they describe, a wild battle's pack
weights and map pool become part of the zone's encounter table, and a rule that reads one or
two values of a content struct takes those values.

### 4.1 One place where a test builds a row

`game-core/src/fixtures.rs` holds one function for each carried struct that gains a field. It
is compiled for `game-core`'s own tests and for a crate that enables `game-core`'s `fixtures`
feature, which `server-module` does in its `[dev-dependencies]` and no crate does in
`[dependencies]`. No production code calls it, and a release build does not contain it: every
release recipe builds one package without its test targets, and under `resolver = "2"` a
dev-dependency's feature does not reach that build.

| Function | Returns | The caller chooses |
| --- | --- | --- |
| `fixtures::skill(id, affinity, power, accuracy)` | `SkillDef` | identity and the three values the damage and accuracy rules read |
| `fixtures::species(id, affinity, base_stats)` | `Species` | identity, type and base stats |
| `fixtures::item(id)` | `ItemDef` | identity |
| `fixtures::encounter_table(zone_id, encounter_rate, entries)` | `EncounterTable` | the three fields the struct has today |

Each function fills every other field with a value that the checks of its own row accept, and
its doc comment spells them. A value that names a row of another registry (a kit's two skill
ids, a map pool) is the test's to set when it joins the two. A test that needs another value
writes it over the fixture with struct-update syntax:
`SkillDef { applies_status: Some(StatusKind::Burn), ..fixtures::skill(1, Affinity::Fire, 40, 100) }`.
A new field on a carried struct is then an edit to one function, and a test that asserts on the
field sets it. `ZoneDef` gains no field and gets no fixture.

The 58 per-file functions of section 1.3 either call the fixture or go. The RON texts of
section 1.3 are not helped by a fixture: each fold line edits the texts of its own type once.

Not chosen: building a server test's row from a shipped row with struct-update syntax, which
needs no feature. The test would then hold whatever the shipped row holds in every field it
does not name, and a content retune could change its result.

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
| `signature` | `Species.tactics.signature` | required |
| `footprint` | `Species.tactics.footprint` | required |
| `range` | `ItemDef.battle_use.range` | absent for an item with no `cure_status` |
| `target_filter` | `ItemDef.battle_use.target_filter` | absent for an item with no `cure_status` |
| `pack_weights` | `EncounterTable.pack_weights` | required |
| `battle_map_pool` | `EncounterTable.battle_map_pool` | required |

- `SkillDef.tactics` is a `TacticsSkillDef` and `Species.tactics` a `TacticsSpeciesDef`: the
  types the registries hold today, without the id key. Each keeps `deny_unknown_fields`, so a
  misspelt lever is a parse error that names the file. A skills row reads
  `(id: 2, name: "Fire Fang", affinity: Fire, power: 70, accuracy: 95, pp: 15, tactics: (tier: Heavy, range_min: 1, range_max: 1, origin: TargetUnit, shape: Single, radius: 0, ff_filter: Enemies))`.
- `ItemDef.battle_use` is an `Option<TacticsItemDef>` with a serde default of `None`; RON spells
  a present one `battle_use: Some((range: 1, target_filter: Ally))`. `validate_tactics_items`
  keeps one rule and its two variants: an item has a `battle_use` exactly when it has a
  `cure_status` (`NotBattleUsable`, `MissingItemEntry`).
- Every field moves with the value it holds. The fold is a move: it deletes no field and no
  check, so `signature` and `footprint` keep the one value the join admits and `DormantLever`
  stays. Whether a field nothing reads (`role`, `signature`, `footprint`, `range`,
  `target_filter`) should exist before its rule does is another question, and section 4.5
  leaves it open.
- `EncounterTable` gains the two fields directly. The `encounter` row keeps its three columns,
  and `encounter_rows_from_table` goes on writing the zone, the rate and the entries.
- `SkillTactics`, `UnitKit` and `SpeciesTactics` keep their fields. They are the engine's view
  of a skill and a battler, and `client-wasm` serialises them. `build_kits(species, skills)`
  still returns one `SpeciesTactics` per species, in the order of `species/` where it follows
  `tactics_species/` today (every reader looks a kit up by species id). It still refuses a kit
  whose skill is not loaded or has the wrong tier (`KitTier`), which is a reference between two
  rows and not a join of two halves of one.

### 4.3 What the fold changes

| Surface | Change |
| --- | --- |
| `CONTENT_VERSION` | Rises by one in each of lines 5 to 8, the four that edit `game-core/content/`: from 29 to 33 if nothing else raises it between. Each regenerates `evals/baselines/content-hash.json`. Lines 1 to 4 do not touch it. |
| A database that holds players | At a publish that carries a rise, the owner's `sync_content` runs its write phase once and every tactical battle in progress is closed at its next load (section 1.5). Every value the sync writes equals the value it replaces: no fold line changes a field a table holds, a base stat, or a value the engine reads. A publish that carries all four rises costs this once; a world that holds players takes lines 5 to 8 in one publish. |
| `species_row` | No column added, removed or re-typed. |
| `skill_row` | No column added, removed or re-typed. |
| `item_row` | No column added, removed or re-typed. `cure_status` stays a field of `ItemDef` and a column. |
| `zone_def` | No column added, removed or re-typed. `ZoneDef` does not change. |
| `encounter` | No column added, removed or re-typed. It keeps its reader. The second schema consolidation takes no change to it from this design, so the spec's clause that it takes the fold's `encounter` change has nothing to take. |
| Generated bindings, `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL`, the schema baselines | Unchanged. No table, view, reducer or `SpacetimeType` changes. |
| `client-wasm` exports | None of the 37 changes its name, its arguments or the shape of its result. `load_tactics_content` calls `build_kits(&species, &skills)` and stops loading two registries. The module's bytes change with the content it embeds. |
| `game-core` rules | `evolve`, `build_monster` and `roll_starter` take a species id and its base stats where they take a `&Species`. `resolve_encounter` takes an encounter rate and a slice of entries, and `roll_encounter` the slice of entries, where they take a `&EncounterTable`. Each returns what it returns today for the same values. |
| `game-core` content API | `build_kits` takes two slices. `TacticsRegistries` holds `species`, `skills`, `items`, `encounters`, `battle_maps` and `tuning`. `load_tactics_skills`, `load_tactics_species`, `load_tactics_items`, `load_tactics_zones`, `TacticsZoneDef`, `cover` and ten variants of `TacticsContentError` go: the nine "two sides disagree" variants for skills, species and zones, and `DuplicateItemEntry`. |
| `game-core/build.rs` | Its registry list goes from eighteen directories to fourteen, one in each of lines 5 to 8. |
| `server-module/src/content_cache.rs` | The four statics and four accessors of section 1.1 go, one pair in each of lines 5 to 8. |
| `load_test_zones` | `tactics_zones!` and `generated_tactics_zones` go; a load-test zone has no encounter table and needs nothing. |

### 4.4 Production code that builds a carried struct, after the fold

| Site | After |
| --- | --- |
| `dmg_ref`, `skill_def_of` | Each fills `tactics` from the `SkillTactics` it is given, which holds the tier and the geometry. No tactical value is invented; the name, the `pp` and the weather they leave empty today stay empty. |
| `species_from_row` | Goes. `apply_evolution` passes `evolve` the target row's id and base stats. |
| `join_with_kit` | Passes `roll_starter` the starter row's id and base stats. Its `Species` literal goes. |
| `generated_zones` | Unchanged: `ZoneDef` gains no field. |
| `table_from_encounter_row` | Replaced by `entries_from_encounter_row`, which returns the row's entries and stays fallible. The grass trigger passes `resolve_encounter` the row's rate and those entries. |
| `start_wild_tactical` | Passes `resolve_encounter` a rate of 1000 and the registry table's entries, so its `EncounterTable` literal goes. From line 8 it reads the pack weights and the map pool from that table where it reads a `TacticsZoneDef` today; `TacticsContent.zones` and `TacticsContent::zone` go. |

`rebuild_recruited` keeps taking a `&Species`: its callers hold a registry row, and it passes
the two values on.

`calc_damage` keeps taking a `&SkillDef`. Narrowing it to the two values it reads would remove
`skill_def_of` and the literal in `dmg_ref`, at the price of a new signature for a rule the
client and the server share and of 29 call sites, most of them in tests the combat plan is
removing. The fold does not need it, so this design does not ask for it.

### 4.5 What this design leaves as it is

- **Two sources for a wild encounter.** The trigger reads the `encounter` row and the start
  reads the registry, and `sync_content` removes no `encounter` row (section 1.4). Removing the
  rows of zones that have left the content, as `sync_content` does for `zone_def`, closes the
  fault under this design. It is a tracked follow-up and no part of the fold.
- **Fields nothing reads.** `role`, `signature`, `footprint`, `range` and `target_filter` move
  as they are. The game design gives each a rule or a place in the HUD that is not built.
- **The decision of where a reducer reads content.** Evolution, the starter grant, training and
  the write-back read `species_row`; battles read the registry. This design changes neither.

## 5. The slices that build it

Each line is one slice and merges alone. Every line is a refactor: nothing a player or a
caller of a reducer can observe changes, and `standards/testing-tdd.md` ("Behavior-preserving
changes") is its proof. Lines 1 and 4 move test scaffolding, which is a tester's edit; line 1
also adds the module and the two manifest lines its tests need. Lines 5 to 8 are the fold. Each
of them starts with a characterization test, written by a tester before the first production
edit, that holds as literals the values the engine reads from the shipped content (the 20 kits,
looked up by species id, for lines 5 and 6; the item entry for line 7; the two zones' pack
weights and pools for line 8); it stays green through the move. The slice for a line deletes
that line and brings `ARCHITECTURE.md` and the decision entry's last sentence in line with what
it leaves; line 8 deletes this file.

| Line | After | Kind |
| --- | --- | --- |
| 1 | nothing | refactor |
| 2 | nothing | refactor |
| 3 | line 2 | refactor |
| 4 | lines 1 and 3 | refactor |
| 5 | line 4 | refactor |
| 6 | line 5 | refactor |
| 7 | line 6 | refactor |
| 8 | line 7 | refactor |

Lines 1 and 2 share no file and can be built together. From line 2 on each line edits files
the next one edits (`server-module/src/marshal.rs`, `movement.rs`, `tactics.rs` and its tests,
`game-core/benches/hot_paths.rs`, `game-core/tests/pt_d3_tuning.rs`; then `CONTENT_VERSION`,
`build.rs`, `tactics/content.rs`, `load_test_zones_tests.rs` and the two `TacticsRegistries`
call sites), so the table orders them one after another.

1. **A test builds a skill in one place.** Adds `game-core/src/fixtures.rs` with
   `fixtures::skill`, the `fixtures` feature in `game-core/Cargo.toml`, and the feature on a
   `game-core` dev-dependency in `server-module/Cargo.toml`. The 48 test literals of `SkillDef`
   in 12 files become calls of it. It shows that the release module and `client-wasm` are built
   without the feature (`cargo tree -e normal,build -e features`, which leaves dev edges out).
   It edits test files that lines 3 to 8 of `docs/refactors/combat-carried-rules.md` also edit,
   so it is not built at the same time as one of them; whichever lands second converts what the
   first left.
2. **The monster rules take the species id and base stats they read.** `evolve`,
   `build_monster` and `roll_starter` (section 4.3); 54 call sites in 14 files, the server's
   four in `evolution.rs`, `movement.rs` and `tactics.rs`.
   `species_from_row` goes with its test in `marshal_tests.rs`, and so does the `Species`
   literal in `join_with_kit`; the two tests of `evolution_tests.rs` that call it pass the row's
   id and base stats. A test that built a `Species` only to call one of the three passes an id
   and a `StatBlock`.
3. **The encounter rules take the rate and entries they read.** `resolve_encounter`
   takes both and `roll_encounter` the entries (section 4.3); 34 call sites in 7 files, the
   server's two being the grass trigger and the spawn roll.
   `table_from_encounter_row` is replaced by `entries_from_encounter_row`; the `EncounterTable`
   literal in `start_wild_tactical` goes.
4. **A test builds a species, an item and an encounter table in one place.** Adds
   `fixtures::species`, `fixtures::item` and `fixtures::encounter_table`. The test literals of
   `Species`, `ItemDef` and `EncounterTable` that lines 2 and 3 left become calls of them (14,
   10 and 11 before those lines, in 11, 4 and 5 files).
5. **A skill's tier and geometry join its row.** `SkillDef.tactics`; the 15 entries of
   `tactics_skills/` move into the two files of `skills/`; `TacticsSkillDef` loses `skill_id`;
   `build_kits` loses its `tactics_skills` argument and `TacticsRegistries` its field;
   `load_tactics_skills`, `DuplicateSkillEntry`, `UnknownSkill`, `MissingSkillEntry`,
   `cached_tactics_skills` and `client-wasm`'s load of the registry go; `dmg_ref` and
   `skill_def_of` fill `tactics`. Callers outside `game-core/src/tactics/`:
   `client-wasm/src/lib.rs` and its `tactics_tests.rs`, `game-core/benches/hot_paths.rs`,
   `game-core/tests/tactics_pacing.rs`, `server-module/src/content.rs`, `content_cache.rs` with
   its tests, `tactics.rs`, `tactics_tests.rs` and `tactics_settle_tests.rs`, the re-exports in
   `game-core/src/lib.rs` and `tactics/mod.rs`, and `game-core/src/load_test_zones_tests.rs`,
   whose `TacticsRegistries` literal compiles only with the `load_test_zones` feature, which
   `just ci` builds. The RON texts of skills in tests gain the block. The comments that cite
   `tactics_skills/000-core.ron` by line (`client/src/tactics/wasm.test.ts`,
   `queueStrip.test.ts`) and the header of `skills/000-core.ron` are brought in line.
   `CONTENT_VERSION` rises.
6. **A species' battler levers and kit join its row.** `Species.tactics`; the 20
   entries of `tactics_species/` move into the eight files of `species/`; `TacticsSpeciesDef`
   loses `species_id`; `build_kits` takes two slices and `TacticsRegistries` loses a field;
   `load_tactics_species`, `DuplicateSpeciesEntry`, `UnknownSpecies`, `MissingSpeciesEntry`,
   `cached_tactics_species` and `client-wasm`'s load go. The same callers as line 5, the
   `load_test_zones_tests.rs` literal included, and the comments in
   `client/src/tactics/provisionalBoard.test.ts`. `CONTENT_VERSION` rises.
7. **A battle item's reach joins its row.** `ItemDef.battle_use`; the one entry of
   `tactics_items/` moves into `items/`; `TacticsItemDef` loses `item_id`;
   `load_tactics_items`, `DuplicateItemEntry` and `cached_tactics_items` go, and
   `TacticsRegistries` loses a field, in `load_test_zones_tests.rs` too.
   `game-core/tests/pt_d3_tuning.rs` lists the battle-usable items from `items/`, and
   `docs/economy-tuning.md` names that directory. `CONTENT_VERSION` rises.
8. **A zone's pack weights and battle maps join its encounter table.**
   `EncounterTable.pack_weights` and `battle_map_pool`; the two entries of `tactics_zones/` move
   into `encounters/` (zone 0's rate, weights and entries, which the recruit e2e depends on,
   stay as they are); `validate_tactics_zones` checks the encounter tables against the maps;
   `start_wild_tactical` reads the two fields from the table (section 4.4); `TacticsZoneDef`,
   `load_tactics_zones`, `DuplicateZoneEntry`, `UnknownZone`, `MissingZoneEntry`, `cover`,
   `cached_tactics_zones`, `load_test_zones::tactics_zones!` and `generated_tactics_zones` go.
   In `.cargo/mutants.toml` the exclusion that names `generated_(zones|zone_maps|tactics_zones)`
   loses its third name and the one for `generated_tactics_zones` alone goes; the manifest
   comments and the header of `battle_maps/000-core.ron` that name the registry are brought in
   line. `taming/types.rs` then names `tactics::encounter::PackWeights`. `TacticsRegistries`
   takes the shape of section 4.3, at its call sites in `server-module/src/content.rs` and
   `tactics.rs` and in `load_test_zones_tests.rs`, most of whose tests of the generated
   tactics rows go with the rows. `content_cache_tests.rs`, `tactics_tests.rs`,
   `tactics_settle_tests.rs` and `pt_d3_tuning.rs` read the pack weights and the pool from the
   encounter table. `CONTENT_VERSION` rises.

## 6. What this rules out

- A registry of tactical fields keyed by the id of the row they describe. A value that
  describes a skill, a species, an item or a zone's wild encounters is a field of that row.
  An encounter table is a row of its own, not a zone's other half: a zone has one or none, and
  it is the unit the trigger and the start read.
- A tactical field that RON may omit for a skill, a species or an encounter table. A row
  without it does not parse, so no check has to find the gap.
- A made-up tactical value in a content struct that production code builds. A rule takes the
  values it reads.
- A fixture called from production code, or compiled into a release build.
- A column on a content table for a field only the engine reads.
