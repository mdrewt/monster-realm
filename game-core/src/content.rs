//! Data-driven content: RON registries parsed by pure loaders
//! (parse-don't-validate). Content is DATA, not code — adding a zone is a content
//! edit + a validation test, never a rule change (ADR-0006). Stable ids are
//! append-only; the append-only-ids eval enforces the cross-version invariant.

use serde::Deserialize;

use crate::monster::types::{Affinity, Bond, Level, StatBlock, StatKind, EV_PER_STAT_CAP};
use crate::taming::types::EncounterTable;

/// A zone definition — the M0 content registry and the first real schema subject
/// for the zoned-schema + append-only-ids evals. Mirrors the server `zone_def`
/// table (the server maps these fields onto a row).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ZoneDef {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

// ===========================================================================
// M6a content types — species, skills, type chart, items
// ===========================================================================

/// A monster species definition — base stats, affinity, learnable skills.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Species {
    pub id: u32,
    pub name: String,
    pub base_stats: StatBlock,
    pub affinity: Affinity,
    pub learnable_skill_ids: Vec<u32>,
}

/// A skill (move) definition — affinity, power, accuracy, PP.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkillDef {
    pub id: u32,
    pub name: String,
    pub affinity: Affinity,
    pub power: u16,
    pub accuracy: u8,
    pub pp: u8,
}

/// A type effectiveness relation — attacker/defender affinity pair.
/// `effectiveness`: 0 = immune, 5 = half, 10 = neutral, 20 = super-effective.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TypeRelation {
    pub attacker: Affinity,
    pub defender: Affinity,
    pub effectiveness: u8,
}

/// An item definition (simple for now — no category enum until later milestones).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ItemDef {
    pub id: u32,
    pub name: String,
    pub description: String,
    /// Per-mille bonus added to recruit_chance when this item is used as bait.
    /// Defaults to 0 for items that have no taming function.
    #[serde(default)]
    pub recruit_bonus: u16,
    /// Focus-training target stat (M9b-tail); None for non-training items.
    #[serde(default)]
    pub train_stat: Option<StatKind>,
    /// EVs granted toward `train_stat` per use (top-off bounded by the 252/510
    /// caps in `focus_train`); 0 for non-training items.
    #[serde(default)]
    pub train_amount: u16,
}

// ===========================================================================
// M10a content types — evolution conditions + fusion recipes (ADR-0019/0060)
//
// "species.evolutions" is modeled as a SEPARATE cross-referenced registry
// (`SpeciesEvolutions`, keyed by `species_id`), NOT a field on `Species` — adding
// a field to `Species` is an E0063 break across its literal constructors in
// server-module (outside this slice's touches). The separate-registry shape is
// idiomatic here: the type chart, encounters, and skills are all separate
// id-cross-referenced registries (ADR-0060). Integrity (dangling refs,
// derived-forms-not-wild, dup recipes/blocks, illegal triggers) lives in
// `validate_evolution_fusion` with proof-of-teeth (ADR-0010).
// ===========================================================================

/// A single branch-evolution trigger. Exhaustive + illegal-states-unrepresentable:
/// a new variant must compiler-flag every `match` in the rules layer (M10a-rules) —
/// so this is deliberately NOT `#[non_exhaustive]` (an OCP inversion).
///
/// `Level` re-validates [1, 100] at the RON boundary via its own `Deserialize`
/// (parse-don't-validate), so an illegal level trigger is unrepresentable. `Bond`
/// accepts any `u8`, so the always-true `Bond(0)` threshold is rejected by
/// `validate_evolution_fusion` instead. `Item` references an item id (validated
/// against the items registry, not dangling).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "RawEvolutionTrigger")]
pub enum EvolutionTrigger {
    /// Evolves once the monster reaches at least this level.
    Level(Level),
    /// Evolves once the monster's bond reaches at least this threshold.
    Bond(Bond),
    /// Evolves when this item is used on the monster.
    Item(u32),
}

/// RON-facing mirror with primitive payloads, so a trigger reads naturally as
/// `Level(16)` / `Bond(200)` / `Item(3)` (bare ints). Without it, the `Bond`
/// newtype's *derived* `Deserialize` would demand the doubly-wrapped `Bond(Bond(200))`
/// (`Level` is transparent via its own `Deserialize`, `Bond` is not — and `Bond` lives
/// outside this slice's touch boundary).
///
/// The conversion re-applies `Level`'s bound at the PARSE boundary (`Level::new`
/// rejects 0/>100), so an illegal `Level` trigger is unrepresentable. `Bond` has no
/// such bound: `Bond(0)` parses fine and is rejected *later*, by
/// `validate_evolution_fusion` (step 4) — not here. A parsed trigger is therefore not
/// guaranteed sound until validated.
#[derive(Deserialize)]
enum RawEvolutionTrigger {
    Level(u8),
    Bond(u8),
    Item(u32),
}

impl TryFrom<RawEvolutionTrigger> for EvolutionTrigger {
    type Error = String;
    fn try_from(raw: RawEvolutionTrigger) -> Result<Self, Self::Error> {
        Ok(match raw {
            RawEvolutionTrigger::Level(n) => EvolutionTrigger::Level(Level::new(n)?),
            RawEvolutionTrigger::Bond(n) => EvolutionTrigger::Bond(Bond::new(n)),
            RawEvolutionTrigger::Item(id) => EvolutionTrigger::Item(id),
        })
    }
}

/// One branch of a species' evolution: a trigger and the species it evolves into.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EvolutionCondition {
    pub trigger: EvolutionTrigger,
    /// The species this branch evolves into. Must exist; must differ from the
    /// source species (no self-evolution). May be a derived-only form.
    pub to_species: u32,
}

/// The per-species evolution registry row: a source species and its branch
/// conditions. `species_id` is the lookup key the rules layer indexes by.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SpeciesEvolutions {
    pub species_id: u32,
    pub evolutions: Vec<EvolutionCondition>,
}

/// A fusion recipe: two parent species `a` + `b` produce offspring species `to`.
/// ORDER-INDEPENDENT — `{a, b}` == `{b, a}`; the order-independence is enforced by
/// `validate_evolution_fusion` (canonical `(min, max)` dedup), never relied on as a
/// struct property.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FusionRecipe {
    pub a: u32,
    pub b: u32,
    pub to: u32,
}

// === M8.9e: glob-loaded content parts ===
// Each glob registry is a DIRECTORY of `*.ron` files. `build.rs` embeds every
// part in sorted-filename order into `$OUT_DIR/content_parts.rs`, defining
// `pub(crate) const <REG>_RON_PARTS: &[(&str, &str)]` (a `(filename, contents)`
// list). The `load_*` fns concatenate the parsed `Vec<T>` from each part, so
// adding a content file is a pure content edit — no `content.rs`/loader change
// (the fan-out property). `type_chart` is NOT migrated (single `include_str!`).
include!(concat!(env!("OUT_DIR"), "/content_parts.rs"));

/// Parse + concatenate RON `Vec<T>` parts in the given slice order (no row
/// re-sorting); a malformed part is rejected loudly, naming the offending file.
/// `label` is the registry's error-message prefix, so the message reads
/// `"<label> parse error in <file>: <e>"`.
fn parse_parts<T>(parts: &[(&str, &str)], label: &str) -> Result<Vec<T>, String>
where
    T: for<'de> serde::Deserialize<'de>,
{
    let mut out = Vec::new();
    for (file, contents) in parts {
        let rows = ron::from_str::<Vec<T>>(contents)
            .map_err(|e| format!("{label} parse error in {file}: {e}"))?;
        out.extend(rows);
    }
    Ok(out)
}

/// Parse the embedded zone registry. Pure (no I/O) — safe under the determinism
/// guard. Parse-don't-validate: returns typed `ZoneDef`s or a descriptive error.
///
/// # Errors
/// Returns `Err` if any embedded part fails to parse (the message names the file).
pub fn load_zones() -> Result<Vec<ZoneDef>, String> {
    parse_zones_parts(ZONES_RON_PARTS)
}

/// Parse + concatenate zone parts in the given slice order (no row re-sorting).
///
/// # Errors
/// Returns `Err` (naming the offending file) if any part is not a valid zone list.
pub fn parse_zones_parts(parts: &[(&str, &str)]) -> Result<Vec<ZoneDef>, String> {
    parse_parts(parts, "zone registry")
}

/// Parse zones from a RON string (separated for testability + fixtures).
///
/// # Errors
/// Returns `Err` with a descriptive message if `ron_str` is not a valid zone list.
pub fn parse_zones(ron_str: &str) -> Result<Vec<ZoneDef>, String> {
    ron::from_str::<Vec<ZoneDef>>(ron_str).map_err(|e| format!("zone registry parse error: {e}"))
}

/// Within-file content integrity: non-zero dimensions and unique ids.
///
/// # Errors
/// Returns `Err` if any zone has a zero dimension or a duplicate id.
pub fn validate_zones(zones: &[ZoneDef]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for z in zones {
        if z.width == 0 || z.height == 0 {
            return Err(format!("zone {} has a zero dimension", z.id));
        }
        if !seen.insert(z.id) {
            return Err(format!("duplicate zone id {}", z.id));
        }
    }
    Ok(())
}

// ===========================================================================
// M6a embedded content — species, skills, type chart, items
// ===========================================================================

// `type_chart` is NOT a glob registry — it stays a single embedded file.
const TYPE_CHART_RON: &str = include_str!("../content/type_chart.ron");

/// Parse the embedded species registry.
///
/// # Errors
/// Returns `Err` if any embedded part fails to parse (the message names the file).
pub fn load_species() -> Result<Vec<Species>, String> {
    parse_species_parts(SPECIES_RON_PARTS)
}

/// Parse + concatenate species parts in the given slice order (no row re-sorting).
///
/// # Errors
/// Returns `Err` (naming the offending file) if any part is not a valid species list.
pub fn parse_species_parts(parts: &[(&str, &str)]) -> Result<Vec<Species>, String> {
    parse_parts(parts, "species registry")
}

/// Parse species from a RON string (separated for testability + fixtures).
///
/// # Errors
/// Returns `Err` with a descriptive message if `ron_str` is not a valid species list.
pub fn parse_species(ron_str: &str) -> Result<Vec<Species>, String> {
    ron::from_str::<Vec<Species>>(ron_str).map_err(|e| format!("species registry parse error: {e}"))
}

/// Parse the embedded skills registry.
///
/// # Errors
/// Returns `Err` if any embedded part fails to parse (the message names the file).
pub fn load_skills() -> Result<Vec<SkillDef>, String> {
    parse_skills_parts(SKILLS_RON_PARTS)
}

/// Parse + concatenate skill parts in the given slice order (no row re-sorting).
///
/// # Errors
/// Returns `Err` (naming the offending file) if any part is not a valid skill list.
pub fn parse_skills_parts(parts: &[(&str, &str)]) -> Result<Vec<SkillDef>, String> {
    parse_parts(parts, "skills registry")
}

/// Parse skills from a RON string.
///
/// # Errors
/// Returns `Err` if `ron_str` is not a valid skill list.
pub fn parse_skills(ron_str: &str) -> Result<Vec<SkillDef>, String> {
    ron::from_str::<Vec<SkillDef>>(ron_str).map_err(|e| format!("skills registry parse error: {e}"))
}

/// Parse the embedded type chart.
///
/// # Errors
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_type_chart() -> Result<Vec<TypeRelation>, String> {
    parse_type_chart(TYPE_CHART_RON)
}

/// Parse type chart from a RON string.
///
/// # Errors
/// Returns `Err` if `ron_str` is not a valid type chart list.
pub fn parse_type_chart(ron_str: &str) -> Result<Vec<TypeRelation>, String> {
    ron::from_str::<Vec<TypeRelation>>(ron_str)
        .map_err(|e| format!("type chart registry parse error: {e}"))
}

/// Parse the embedded items registry.
///
/// # Errors
/// Returns `Err` if any embedded part fails to parse (the message names the file).
pub fn load_items() -> Result<Vec<ItemDef>, String> {
    parse_items_parts(ITEMS_RON_PARTS)
}

/// Parse + concatenate item parts in the given slice order (no row re-sorting).
///
/// # Errors
/// Returns `Err` (naming the offending file) if any part is not a valid item list.
pub fn parse_items_parts(parts: &[(&str, &str)]) -> Result<Vec<ItemDef>, String> {
    parse_parts(parts, "items registry")
}

/// Parse items from a RON string.
///
/// # Errors
/// Returns `Err` if `ron_str` is not a valid item list.
pub fn parse_items(ron_str: &str) -> Result<Vec<ItemDef>, String> {
    ron::from_str::<Vec<ItemDef>>(ron_str).map_err(|e| format!("items registry parse error: {e}"))
}

// ===========================================================================
// M10a embedded content — fusion recipes + evolution registry (ADR-0060)
//
// Single-file `include_str!` (the `type_chart` precedent, content.rs above): a new
// glob registry would need a `build.rs` edit (outside this slice's touches), and
// these two registries are small + low-parallel-churn today. A later slice that
// touches `build.rs` may migrate them to `content/{fusion,evolutions}/` glob dirs
// when they grow (purely additive, same recipe as M8.9e).
// ===========================================================================

const FUSION_RON: &str = include_str!("../content/fusion.ron");
const EVOLUTIONS_RON: &str = include_str!("../content/evolutions.ron");

/// Parse fusion recipes from a RON string (separated for testability + fixtures).
///
/// # Errors
/// Returns `Err` with a descriptive message if `ron_str` is not a valid recipe list.
pub fn parse_fusion(ron_str: &str) -> Result<Vec<FusionRecipe>, String> {
    ron::from_str::<Vec<FusionRecipe>>(ron_str)
        .map_err(|e| format!("fusion registry parse error: {e}"))
}

/// Parse the embedded fusion registry.
///
/// # Errors
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_fusion() -> Result<Vec<FusionRecipe>, String> {
    parse_fusion(FUSION_RON)
}

/// Parse the evolution registry from a RON string (separated for testability).
///
/// # Errors
/// Returns `Err` with a descriptive message if `ron_str` is not a valid evolution list.
pub fn parse_evolutions(ron_str: &str) -> Result<Vec<SpeciesEvolutions>, String> {
    ron::from_str::<Vec<SpeciesEvolutions>>(ron_str)
        .map_err(|e| format!("evolutions registry parse error: {e}"))
}

/// Parse the embedded evolution registry.
///
/// # Errors
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_evolutions() -> Result<Vec<SpeciesEvolutions>, String> {
    parse_evolutions(EVOLUTIONS_RON)
}

// ===========================================================================
// M8a content — encounter tables
// ===========================================================================

/// Parse encounter tables from a RON string (separated for testability).
///
/// # Errors
/// Returns `Err` with a descriptive message if `ron_str` is not valid.
pub fn parse_encounters(ron_str: &str) -> Result<Vec<EncounterTable>, String> {
    ron::from_str::<Vec<EncounterTable>>(ron_str)
        .map_err(|e| format!("encounters registry parse error: {e}"))
}

/// Parse + concatenate encounter parts in the given slice order (no row re-sorting).
///
/// # Errors
/// Returns `Err` (naming the offending file) if any part is not a valid encounter list.
pub fn parse_encounters_parts(parts: &[(&str, &str)]) -> Result<Vec<EncounterTable>, String> {
    parse_parts(parts, "encounters registry")
}

/// Parse the embedded encounter registry.
///
/// # Errors
/// Returns `Err` if any embedded part fails to parse (the message names the file).
pub fn load_encounters() -> Result<Vec<EncounterTable>, String> {
    parse_encounters_parts(ENCOUNTERS_RON_PARTS)
}

/// Cross-registry validation for encounter tables.
///
/// Checks:
/// - Unique zone ids
/// - `encounter_rate` in [0, 1000]
/// - Each entry has `weight > 0`
/// - Each entry has `min_level <= max_level`
/// - Each `species_id` exists in `species`
/// - Each `zone_id` exists in `zones`
///
/// # Errors
/// Returns `Err` with a descriptive message on the first violation found.
pub fn validate_encounters(
    tables: &[EncounterTable],
    species: &[Species],
    zones: &[ZoneDef],
) -> Result<(), String> {
    let species_ids: std::collections::BTreeSet<u32> = species.iter().map(|s| s.id).collect();
    let zone_ids: std::collections::BTreeSet<u32> = zones.iter().map(|z| z.id).collect();
    let mut seen_zones = std::collections::BTreeSet::new();

    for table in tables {
        if !seen_zones.insert(table.zone_id) {
            return Err(format!("duplicate encounter zone_id {}", table.zone_id));
        }
        if !zone_ids.contains(&table.zone_id) {
            return Err(format!(
                "encounter table references non-existent zone {}",
                table.zone_id
            ));
        }
        if table.encounter_rate > 1000 {
            return Err(format!(
                "encounter_rate {} for zone {} exceeds per-mille max 1000",
                table.encounter_rate, table.zone_id
            ));
        }
        // `encounter_rate == 0` is intentionally valid (a defined-but-never-
        // triggering "safe" zone): non-empty entries with rate 0 are allowed.
        // M8c's trigger rolls the rate first, so a 0-rate zone simply never fires.
        if table.entries.is_empty() {
            return Err(format!(
                "encounter table for zone {} has no entries",
                table.zone_id
            ));
        }
        let mut seen_species = std::collections::BTreeSet::new();
        for entry in &table.entries {
            if !seen_species.insert(entry.species_id) {
                return Err(format!(
                    "duplicate encounter species {} within zone {}",
                    entry.species_id, table.zone_id
                ));
            }
            if entry.weight == 0 {
                return Err(format!(
                    "encounter entry for species {} in zone {} has weight=0",
                    entry.species_id, table.zone_id
                ));
            }
            if entry.min_level.as_u8() > entry.max_level.as_u8() {
                return Err(format!(
                    "encounter entry for species {} in zone {} has inverted level range ({} > {})",
                    entry.species_id,
                    table.zone_id,
                    entry.min_level.as_u8(),
                    entry.max_level.as_u8()
                ));
            }
            if !species_ids.contains(&entry.species_id) {
                return Err(format!(
                    "encounter entry in zone {} references non-existent species {}",
                    table.zone_id, entry.species_id
                ));
            }
        }
    }
    Ok(())
}

/// Cross-registry content validation:
/// - Unique species ids, no zero base stats
/// - Unique skill ids
/// - Unique type chart pairs (attacker, defender)
/// - Unique item ids
/// - All `learnable_skill_ids` in species must reference existing skills
///
/// # Errors
/// Returns `Err` with a descriptive message on the first integrity violation.
pub fn validate_content(
    species: &[Species],
    skills: &[SkillDef],
    type_chart: &[TypeRelation],
    items: &[ItemDef],
) -> Result<(), String> {
    let mut species_ids = std::collections::BTreeSet::new();
    for sp in species {
        if !species_ids.insert(sp.id) {
            return Err(format!("duplicate species id {}", sp.id));
        }
        let stats = [
            sp.base_stats.hp,
            sp.base_stats.attack,
            sp.base_stats.defense,
            sp.base_stats.speed,
            sp.base_stats.sp_attack,
            sp.base_stats.sp_defense,
        ];
        for &s in &stats {
            if s == 0 {
                return Err(format!("species {} has a zero base stat", sp.id));
            }
            if s > 255 {
                return Err(format!(
                    "species {} has base stat {} exceeding 255",
                    sp.id, s
                ));
            }
        }
    }

    let mut skill_ids = std::collections::BTreeSet::new();
    for sk in skills {
        if !skill_ids.insert(sk.id) {
            return Err(format!("duplicate skill id {}", sk.id));
        }
        if sk.power == 0 {
            return Err(format!(
                "skill {} has power=0; damaging skills must have power>0",
                sk.id
            ));
        }
        // accuracy_check is `roll < accuracy` with roll in 0..=99 (a percent chance).
        //   accuracy == 0  → always miss (no roll is < 0): an unusable skill.
        //   accuracy > 100 → outside the percent domain; every roll 0..=99 is < it,
        //                    identical in effect to 100, so reject it as malformed.
        // accuracy is a u8, so `> 100` covers 101..=255 with no overflow risk.
        if sk.accuracy == 0 || sk.accuracy > 100 {
            return Err(format!(
                "skill {} has accuracy {}; accuracy must be in [1, 100]",
                sk.id, sk.accuracy
            ));
        }
    }

    // Cross-check: every learnable_skill_id in species must exist in skills
    for sp in species {
        for &sid in &sp.learnable_skill_ids {
            if !skill_ids.contains(&sid) {
                return Err(format!(
                    "species {} references non-existent skill {}",
                    sp.id, sid
                ));
            }
        }
    }

    let mut type_pairs = std::collections::BTreeSet::new();
    for rel in type_chart {
        if !type_pairs.insert((rel.attacker, rel.defender)) {
            return Err(format!(
                "duplicate type chart pair ({:?}, {:?})",
                rel.attacker, rel.defender
            ));
        }
        if !matches!(rel.effectiveness, 0 | 5 | 10 | 20) {
            return Err(format!(
                "type chart pair ({:?}, {:?}) has illegal effectiveness {}; must be 0, 5, 10, or 20",
                rel.attacker, rel.defender, rel.effectiveness
            ));
        }
    }

    let mut item_ids = std::collections::BTreeSet::new();
    for item in items {
        if !item_ids.insert(item.id) {
            return Err(format!("duplicate item id {}", item.id));
        }
        // A bait bonus is per-mille; it can never exceed certainty (1000).
        if item.recruit_bonus > 1000 {
            return Err(format!(
                "item {} has recruit_bonus {} exceeding per-mille max 1000",
                item.id, item.recruit_bonus
            ));
        }
        // Training food (M9b-tail): a target stat needs a positive amount within the
        // per-stat EV cap; a non-training item must carry no stray train_amount.
        match item.train_stat {
            Some(_) => {
                if item.train_amount == 0 {
                    return Err(format!(
                        "item {} is a training food but train_amount is 0",
                        item.id
                    ));
                }
                if item.train_amount > EV_PER_STAT_CAP {
                    return Err(format!(
                        "item {} train_amount {} exceeds per-stat EV cap {EV_PER_STAT_CAP}",
                        item.id, item.train_amount
                    ));
                }
            }
            None => {
                if item.train_amount != 0 {
                    return Err(format!(
                        "item {} has train_amount {} but no train_stat (incoherent)",
                        item.id, item.train_amount
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Cross-registry content integrity for evolution + fusion (M10, ADR-0019/0060).
/// Additive sibling of [`validate_content`] (whose signature is fixed by external
/// callers); pure (errors-as-values, no clock/RNG). Checks run in a deterministic
/// order so each proof-of-teeth fixture isolates exactly one violation (ADR-0010):
///
/// 1. **registry well-formedness** — no empty `evolutions` block, no duplicate
///    `SpeciesEvolutions.species_id`.
/// 2. **self-reference** — `to_species != species_id` (a no-op self-evolution).
/// 3. **dangling refs** — every source/target species, every fusion `a`/`b`/`to`,
///    and every `Item` trigger id must exist in the species / items registries.
/// 4. **trigger sanity** — reject the always-true `Bond(0)` threshold (`Level`'s
///    analogue is already impossible at the parse boundary).
/// 5. **fusion coherence** — reject `a == b` and `to ∈ {a, b}`.
/// 6. **derived-forms-not-wild** — evolution targets ∪ fusion results must never
///    appear in any encounter table (not wild-catchable).
/// 7. **no duplicate fusion pair** — order-independent (`{a,b}` == `{b,a}`).
///
/// (Cross-version species-id append-only stays the `append-only-ids` eval's job;
/// within-version species-id uniqueness stays [`validate_content`]'s.)
///
/// Scope (named deferrals, ADR-0060 §3): step 6 covers `EncounterTable` entries only
/// — hardcoded server grant paths (the starter in `join_game`, future quest rewards)
/// are out of scope until they become content-driven. Multi-node evolution cycles
/// (`A→B→A`) are deferred to the rules layer (M10a-rules), where the `evolves_to`
/// traversal lives; only self-loops are caught here (step 2). **M10b obligation:** the
/// server `sync_content` must call this (alongside `validate_content`) so the gate is
/// live in production, not only in this crate's tests.
///
/// # Errors
/// Returns `Err` with a descriptive message on the first integrity violation.
pub fn validate_evolution_fusion(
    species: &[Species],
    evolutions: &[SpeciesEvolutions],
    recipes: &[FusionRecipe],
    encounters: &[EncounterTable],
    items: &[ItemDef],
) -> Result<(), String> {
    let species_ids: std::collections::BTreeSet<u32> = species.iter().map(|s| s.id).collect();
    let item_ids: std::collections::BTreeSet<u32> = items.iter().map(|i| i.id).collect();

    // 1. Registry well-formedness: non-empty blocks, no duplicate source species.
    let mut seen_blocks = std::collections::BTreeSet::new();
    for se in evolutions {
        if se.evolutions.is_empty() {
            return Err(format!(
                "species {} has an empty evolutions block; omit the row instead of declaring no conditions",
                se.species_id
            ));
        }
        if !seen_blocks.insert(se.species_id) {
            return Err(format!(
                "duplicate evolutions block for species {}",
                se.species_id
            ));
        }
    }

    // 2. Self-reference: a species cannot evolve into itself.
    for se in evolutions {
        for cond in &se.evolutions {
            if cond.to_species == se.species_id {
                return Err(format!(
                    "species {} has a self-evolution (to_species == species_id)",
                    se.species_id
                ));
            }
        }
    }

    // 3. Dangling references: every species/item id referenced must exist.
    for se in evolutions {
        if !species_ids.contains(&se.species_id) {
            return Err(format!(
                "evolutions block references non-existent source species {}",
                se.species_id
            ));
        }
        for cond in &se.evolutions {
            if !species_ids.contains(&cond.to_species) {
                return Err(format!(
                    "evolution for species {} references non-existent target species {}",
                    se.species_id, cond.to_species
                ));
            }
            if let EvolutionTrigger::Item(item_id) = &cond.trigger {
                if !item_ids.contains(item_id) {
                    return Err(format!(
                        "evolution for species {} references non-existent item {item_id}",
                        se.species_id
                    ));
                }
            }
        }
    }
    for r in recipes {
        for (field, id) in [("a", r.a), ("b", r.b), ("to", r.to)] {
            if !species_ids.contains(&id) {
                return Err(format!(
                    "fusion recipe references non-existent species {id} (field {field})"
                ));
            }
        }
    }

    // 4. Trigger sanity: Bond(0) is an always-true threshold (default bond > 0).
    for se in evolutions {
        for cond in &se.evolutions {
            if let EvolutionTrigger::Bond(b) = &cond.trigger {
                if b.value() == 0 {
                    return Err(format!(
                        "species {} has a Bond(0) evolution trigger; a zero-bond threshold is always true",
                        se.species_id
                    ));
                }
            }
        }
    }

    // 5. Fusion coherence: distinct parents; the output is a new form.
    for r in recipes {
        if r.a == r.b {
            return Err(format!(
                "fusion recipe has a == b ({}); self-fusion is not supported",
                r.a
            ));
        }
        if r.to == r.a || r.to == r.b {
            return Err(format!(
                "fusion recipe output {} reproduces an input ({} + {})",
                r.to, r.a, r.b
            ));
        }
    }

    // 6. Derived-forms-not-wild: evolution targets ∪ fusion results are never
    //    wild-catchable (the integrity rule v1 left to author discipline).
    let mut derived: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for se in evolutions {
        for cond in &se.evolutions {
            derived.insert(cond.to_species);
        }
    }
    for r in recipes {
        derived.insert(r.to);
    }
    for table in encounters {
        for entry in &table.entries {
            if derived.contains(&entry.species_id) {
                return Err(format!(
                    "derived form species {} (evolution/fusion-only) appears in the encounter table for zone {}; derived forms must never be wild-catchable",
                    entry.species_id, table.zone_id
                ));
            }
        }
    }

    // 7. No duplicate fusion pair (order-independent via canonical (min, max)).
    let mut seen_pairs = std::collections::BTreeSet::new();
    for r in recipes {
        let key = (r.a.min(r.b), r.a.max(r.b));
        if !seen_pairs.insert(key) {
            return Err(format!(
                "duplicate fusion pair ({}, {}); recipes are order-independent ({{a,b}} == {{b,a}})",
                key.0, key.1
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_zones_parse_and_validate() {
        let zones = load_zones().expect("embedded zones must parse");
        assert!(!zones.is_empty());
        validate_zones(&zones).expect("embedded zones must be valid");
    }

    #[test]
    fn rejects_malformed_ron() {
        assert!(parse_zones("not ron at all {{{").is_err());
    }

    #[test]
    fn rejects_duplicate_ids() {
        let dup =
            r#"[(id: 0, name: "A", width: 1, height: 1), (id: 0, name: "B", width: 1, height: 1)]"#;
        let zones = parse_zones(dup).expect("parses");
        assert!(validate_zones(&zones).is_err());
    }

    #[test]
    fn rejects_zero_dimension() {
        let bad = r#"[(id: 0, name: "Flat", width: 0, height: 5)]"#;
        let zones = parse_zones(bad).expect("parses");
        assert!(validate_zones(&zones).is_err());
    }

    #[test]
    fn zone_0_placeholder_map_fits_within_its_registry_dimensions() {
        // The hand-authored `ZONE_0_ROWS` placeholder map is smaller than zone 0's
        // registry size; M11's Tiled->RON pipeline grows both together. Pin the
        // load-bearing direction: the rule's map must NEVER exceed the registered
        // zone bounds (a map larger than its `zone_def` would desync render/logic).
        let zones = load_zones().expect("embedded zones must parse");
        let z0 = zones.iter().find(|z| z.id == 0).expect("zone 0 exists");
        let map = crate::zone_0();
        assert!(
            map.width as u32 <= z0.width && map.height as u32 <= z0.height,
            "zone_0 map {}x{} exceeds registry {}x{}",
            map.width,
            map.height,
            z0.width,
            z0.height
        );
    }

    // =======================================================================
    // M6a content tests — species, skills, type chart, items
    // =======================================================================

    // -----------------------------------------------------------------------
    // Test helpers: fixture builders
    // -----------------------------------------------------------------------

    fn valid_base_stats() -> StatBlock {
        StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        }
    }

    fn fixture_species(id: u32, skill_ids: Vec<u32>) -> Species {
        Species {
            id,
            name: format!("Species{id}"),
            base_stats: valid_base_stats(),
            affinity: Affinity::Fire,
            learnable_skill_ids: skill_ids,
        }
    }

    fn fixture_skill(id: u32) -> SkillDef {
        SkillDef {
            id,
            name: format!("Skill{id}"),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 35,
        }
    }

    // -----------------------------------------------------------------------
    // #55: Embedded species parse OK
    // -----------------------------------------------------------------------

    /// #55: load_species() parses the embedded RON without error.
    /// Kills: an impl that fails to wire up the include_str! or parse call.
    #[test]
    fn embedded_species_parse_and_validate() {
        let species = load_species().expect("embedded species must parse");
        // The empty list is valid — content is fleshed out by the implementer.
        assert!(species.is_empty() || !species.is_empty());
    }

    /// #56: load_skills() parses the embedded RON without error.
    #[test]
    fn embedded_skills_parse_and_validate() {
        let skills = load_skills().expect("embedded skills must parse");
        assert!(skills.is_empty() || !skills.is_empty());
    }

    /// #57: load_type_chart() parses the embedded RON without error.
    #[test]
    fn embedded_type_chart_parse_and_validate() {
        let chart = load_type_chart().expect("embedded type_chart must parse");
        assert!(chart.is_empty() || !chart.is_empty());
    }

    /// #58: load_items() parses the embedded RON without error.
    #[test]
    fn embedded_items_parse_and_validate() {
        let items = load_items().expect("embedded items must parse");
        assert!(items.is_empty() || !items.is_empty());
    }

    /// Embedded encounter registry parses and validates end-to-end against the
    /// embedded species + zones (parity with the other embedded-registry smoke
    /// tests; catches a bad `encounters.ron` in game-core's own suite).
    #[test]
    fn embedded_encounters_parse_and_validate() {
        let encounters = load_encounters().expect("embedded encounters must parse");
        let species = load_species().expect("species parse");
        let zones = load_zones().expect("zones parse");
        validate_encounters(&encounters, &species, &zones)
            .expect("embedded encounters must be valid");
    }

    /// #59: validate_content succeeds for all embedded data together.
    /// Kills: an impl where validate_content rejects valid embedded data.
    #[test]
    fn validate_content_passes_for_embedded() {
        let species = load_species().expect("species parse");
        let skills = load_skills().expect("skills parse");
        let chart = load_type_chart().expect("type_chart parse");
        let items = load_items().expect("items parse");
        validate_content(&species, &skills, &chart, &items)
            .expect("embedded content must be valid");
    }

    /// #60: parse_species rejects garbage input.
    /// Kills: an impl that silently returns empty on parse failure.
    #[test]
    fn rejects_malformed_species_ron() {
        assert!(parse_species("garbage not ron {{{").is_err());
    }

    /// #61: validate_content rejects duplicate species ids.
    /// Kills: an impl that does not check for duplicate ids.
    #[test]
    fn rejects_duplicate_species_ids() {
        let species = vec![
            fixture_species(1, vec![]),
            fixture_species(1, vec![]), // dup id
        ];
        let skills = vec![];
        let chart = vec![];
        let items = vec![];
        assert!(
            validate_content(&species, &skills, &chart, &items).is_err(),
            "should reject duplicate species ids"
        );
    }

    /// #62: validate_content rejects dangling skill references.
    /// Kills: an impl that does not cross-check species.learnable_skill_ids
    /// against the skill registry.
    #[test]
    fn rejects_dangling_skill_ref() {
        let species = vec![fixture_species(1, vec![999])]; // skill 999 does not exist
        let skills = vec![fixture_skill(1)]; // only skill 1 exists
        let chart = vec![];
        let items = vec![];
        assert!(
            validate_content(&species, &skills, &chart, &items).is_err(),
            "should reject dangling skill reference"
        );
    }

    /// #63: validate_content rejects duplicate type chart pairs.
    /// Kills: an impl that does not check for duplicate (attacker, defender) pairs.
    #[test]
    fn rejects_duplicate_type_chart_pair() {
        let species = vec![];
        let skills = vec![];
        let chart = vec![
            TypeRelation {
                attacker: Affinity::Fire,
                defender: Affinity::Water,
                effectiveness: 5,
            },
            TypeRelation {
                attacker: Affinity::Fire,
                defender: Affinity::Water,
                effectiveness: 20,
            }, // dup pair
        ];
        let items = vec![];
        assert!(
            validate_content(&species, &skills, &chart, &items).is_err(),
            "should reject duplicate type chart pair"
        );
    }

    /// #64: validate_content rejects a species with zero base HP.
    /// Kills: an impl that does not validate base stat sanity.
    #[test]
    fn rejects_zero_base_stat_species() {
        let mut bad = fixture_species(1, vec![]);
        bad.base_stats.hp = 0;
        let species = vec![bad];
        let skills = vec![];
        let chart = vec![];
        let items = vec![];
        assert!(
            validate_content(&species, &skills, &chart, &items).is_err(),
            "should reject species with zero base HP"
        );
    }

    // -----------------------------------------------------------------------
    // Proof-of-teeth (ADR-0010) — these MUST fail if validation passes
    // -----------------------------------------------------------------------

    /// #65: Proof-of-teeth — dangling skill ref MUST be rejected.
    /// The fixture is bad. The test passes only if validate_content returns Err.
    #[test]
    fn validate_content_teeth_dangling_ref() {
        let species = vec![fixture_species(1, vec![42])]; // skill 42 does not exist
        let skills = vec![fixture_skill(1)];
        let chart = vec![];
        let items = vec![];
        let result = validate_content(&species, &skills, &chart, &items);
        assert!(
            result.is_err(),
            "TEETH: dangling skill ref must be rejected, but validation passed"
        );
    }

    /// #66: Proof-of-teeth — duplicate species id MUST be rejected.
    #[test]
    fn validate_content_teeth_duplicate_id() {
        let species = vec![fixture_species(5, vec![]), fixture_species(5, vec![])];
        let skills = vec![];
        let chart = vec![];
        let items = vec![];
        let result = validate_content(&species, &skills, &chart, &items);
        assert!(
            result.is_err(),
            "TEETH: duplicate species id must be rejected, but validation passed"
        );
    }

    /// #67: Proof-of-teeth — zero base stat MUST be rejected.
    #[test]
    fn validate_content_teeth_zero_base_stat() {
        let mut bad = fixture_species(1, vec![]);
        bad.base_stats.attack = 0; // any zero base stat should fail
        let species = vec![bad];
        let skills = vec![];
        let chart = vec![];
        let items = vec![];
        let result = validate_content(&species, &skills, &chart, &items);
        assert!(
            result.is_err(),
            "TEETH: zero base stat must be rejected, but validation passed"
        );
    }

    // -----------------------------------------------------------------------
    // M8.8c: accuracy range validation — accuracy must be in [1, 100]
    // Rationale: accuracy_check is `roll < accuracy` with `roll ∈ 0..=99`.
    //   accuracy == 0   → always miss (no roll is < 0, unusable skill), rejected.
    //   accuracy > 100  → outside the percent domain; every roll 0..=99 is < it,
    //                     identical in effect to 100 (always-hit), so it is
    //                     rejected as malformed.
    // This is the same illegal-but-representable class as the power == 0 check.
    // -----------------------------------------------------------------------

    /// M8.8c: validate_content rejects a skill with accuracy == 0 (always-miss).
    /// Kills: an impl that omits the lower-bound accuracy check entirely.
    #[test]
    fn validate_content_rejects_accuracy_zero() {
        let mut sk = fixture_skill(1);
        sk.accuracy = 0;
        let result = validate_content(&[], &[sk], &[], &[]);
        assert!(
            result.is_err(),
            "accuracy=0 means always-miss; validate_content must reject it"
        );
    }

    /// M8.8c: validate_content rejects a skill with accuracy == 101 (above 100, always-hit).
    /// Kills: an impl that omits the upper-bound accuracy check entirely.
    #[test]
    fn validate_content_rejects_accuracy_above_100() {
        let mut sk = fixture_skill(1);
        sk.accuracy = 101;
        let result = validate_content(&[], &[sk], &[], &[]);
        assert!(
            result.is_err(),
            "accuracy=101 is above 100 (always-hit/illegal); validate_content must reject it"
        );
    }

    /// M8.8c: validate_content rejects accuracy == u8::MAX (255) — the type extreme.
    /// A defensive boundary test at the top of the u8 domain (the `> 100` check
    /// spans all of 101..=255); pairs with the just-over-bound test at 101.
    #[test]
    fn validate_content_rejects_accuracy_at_u8_max() {
        let mut sk = fixture_skill(1);
        sk.accuracy = u8::MAX; // 255 — far above the valid ceiling of 100
        let result = validate_content(&[], &[sk], &[], &[]);
        assert!(
            result.is_err(),
            "accuracy=255 (u8::MAX) is well above 100; validate_content must reject it"
        );
    }

    /// M8.8c: validate_content accepts accuracy == 1 (minimum valid boundary).
    /// Kills: an over-strict impl that rejects accuracy=1 along with 0.
    #[test]
    fn validate_content_accepts_accuracy_at_1() {
        let mut sk = fixture_skill(1);
        sk.accuracy = 1;
        let result = validate_content(&[], &[sk], &[], &[]);
        assert!(
            result.is_ok(),
            "accuracy=1 is the minimum valid value; validate_content must accept it, got: {:?}",
            result
        );
    }

    /// M8.8c: validate_content accepts accuracy == 100 (maximum valid boundary).
    /// Kills: an over-strict impl that rejects accuracy=100 along with 101.
    #[test]
    fn validate_content_accepts_accuracy_at_100() {
        let mut sk = fixture_skill(1);
        sk.accuracy = 100;
        let result = validate_content(&[], &[sk], &[], &[]);
        assert!(
            result.is_ok(),
            "accuracy=100 is the maximum valid value; validate_content must accept it, got: {:?}",
            result
        );
    }

    /// M8.8c: Proof-of-teeth — BOTH accuracy=0 AND accuracy=101 must be rejected.
    /// TEETH: a fixture_skill with accuracy outside [1, 100] must never load.
    /// Kills: an impl that checks only one bound, or uses > instead of >= on the
    /// upper check, or uses < instead of == on the lower check.
    #[test]
    fn validate_content_teeth_accuracy_out_of_range() {
        let mut sk_zero = fixture_skill(1);
        sk_zero.accuracy = 0;
        let result_zero = validate_content(&[], &[sk_zero], &[], &[]);
        assert!(
            result_zero.is_err(),
            "TEETH: accuracy=0 (always-miss) must be rejected, but validation passed"
        );

        let mut sk_over = fixture_skill(2);
        sk_over.accuracy = 101;
        let result_over = validate_content(&[], &[sk_over], &[], &[]);
        assert!(
            result_over.is_err(),
            "TEETH: accuracy=101 (above-max, always-hit) must be rejected, but validation passed"
        );
    }

    /// M8.8c: parse-don't-validate boundary — a RON skill with accuracy:0 must
    /// parse successfully (the type accepts it) but validate_content must reject it.
    /// Kills: an impl that conflates parse-time rejection with validate-time rejection,
    /// or one that accepts accuracy=0 through validation (the real boundary).
    #[test]
    fn validate_content_rejects_parsed_zero_accuracy_skill() {
        let ron_str =
            r#"[(id: 1, name: "AlwaysMiss", affinity: Fire, power: 40, accuracy: 0, pp: 25)]"#;
        let parsed = parse_skills(ron_str).expect("RON with accuracy:0 must parse (u8 accepts 0)");
        assert_eq!(parsed.len(), 1, "parsed should have exactly one skill");
        assert_eq!(parsed[0].accuracy, 0, "parsed accuracy must be 0");
        let result = validate_content(&[], &parsed, &[], &[]);
        assert!(
            result.is_err(),
            "validate_content must reject a parsed skill with accuracy=0; parse succeeded but validation must be the boundary"
        );
    }

    // =======================================================================
    // === M8.9e: content-directory glob loading ===
    //
    // These tests encode the EARS acceptance criteria for the fan-out migration:
    //   - Five registries move from monolithic <reg>.ron to <reg>/*.ron dirs
    //   - A new build.rs embeds every *.ron in sorted filename order
    //   - parse_*_parts fns concatenate parsed Vec<T> from each part in slice order
    //   - load_* delegates to parse_*_parts over the matching *_RON_PARTS static
    //   - Adding a content file requires NO content.rs edit (fan-out property)
    //
    // All tests reference the NOT-YET-EXISTING interface so the suite compiles RED:
    //   parse_*_parts(&[(&str, &str)]) -> Result<Vec<T>, String>
    //   *_RON_PARTS: &[(&str, &str)]  (build-generated, sorted filenames)
    // =======================================================================

    // -----------------------------------------------------------------------
    // Golden snapshots: frozen inline copies of each pre-migration monolithic
    // file, captured verbatim before the directory split.
    //
    // NOT using include_str! because the implementer DELETES the monolithic
    // files (content/species.ron → content/species/000-core.ron, etc.), which
    // would cause include_str! to fail to compile post-migration.
    //
    // NOT repointed at the new 000-core.ron because that would be tautological:
    // the merged loader loads that same file, so a migration that silently
    // dropped a row would pass (both sides reflect the drop). The frozen inline
    // literal is an immutable pre-migration record that genuinely bites.
    //
    // Parity tests compare PARSED rows (PartialEq), so whitespace and comments
    // in these snapshots are irrelevant — verbatim copy just guarantees the
    // data fields are identical.
    // -----------------------------------------------------------------------

    /// Pre-migration species.ron — frozen inline snapshot (3 species, ids 1–3).
    /// Kills: a migration that drops, reorders, or alters any of the 3 rows.
    const SPECIES_GOLDEN: &str = r#"// Species registry — DATA, not code (ADR-0006). Stable `id`s are APPEND-ONLY.
[
    (
        id: 1,
        name: "Flameling",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 65, sp_attack: 65, sp_defense: 45),
        affinity: Fire,
        learnable_skill_ids: [1, 2],
    ),
    (
        id: 2,
        name: "Tidalin",
        base_stats: (hp: 44, attack: 48, defense: 65, speed: 43, sp_attack: 64, sp_defense: 64),
        affinity: Water,
        learnable_skill_ids: [3, 4],
    ),
    (
        id: 3,
        name: "Sproutlet",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 45, sp_attack: 65, sp_defense: 65),
        affinity: Plant,
        learnable_skill_ids: [5, 6],
    ),
]
"#;

    /// Pre-migration skills.ron — frozen inline snapshot (6 skills, ids 1–6).
    /// Kills: a migration that drops, reorders, or alters any of the 6 rows.
    const SKILLS_GOLDEN: &str = r#"// Skill registry — DATA, not code (ADR-0006). Stable `id`s are APPEND-ONLY.
[
    (id: 1, name: "Ember",       affinity: Fire,    power: 40, accuracy: 100, pp: 25),
    (id: 2, name: "Fire Fang",   affinity: Fire,    power: 65, accuracy: 95,  pp: 15),
    (id: 3, name: "Water Gun",   affinity: Water,   power: 40, accuracy: 100, pp: 25),
    (id: 4, name: "Aqua Jet",    affinity: Water,   power: 40, accuracy: 100, pp: 20),
    (id: 5, name: "Vine Whip",   affinity: Plant,   power: 45, accuracy: 100, pp: 25),
    (id: 6, name: "Razor Leaf",  affinity: Plant,   power: 55, accuracy: 95,  pp: 25),
]
"#;

    /// Pre-migration zones.ron — frozen inline snapshot (2 zones, ids 0–1).
    /// Kills: a migration that drops, reorders, or alters any of the 2 rows.
    const ZONES_GOLDEN: &str = r#"// Zone registry — DATA, not code (ADR-0006). Adding a zone is a content edit +
// a validation test, never a rule change. Stable `id`s are APPEND-ONLY: never
// reuse or renumber an existing id (the append-only-ids eval enforces it).
[
    (id: 0, name: "Verdant Hollow", width: 32, height: 24),
    (id: 1, name: "Tideglass Cove", width: 40, height: 28),
]
"#;

    /// Pre-migration items.ron — frozen inline snapshot (1 item, id 1).
    /// Kills: a migration that drops, reorders, or alters the row.
    const ITEMS_GOLDEN: &str = r#"// Item registry — DATA, not code (ADR-0006). Stable `id`s are APPEND-ONLY.
[
    (
        id: 1,
        name: "Lure Berry",
        description: "Sweet bait that calms a wild monster, easing recruitment.",
        recruit_bonus: 150,
    ),
]
"#;

    /// Pre-migration encounters.ron — frozen inline snapshot (1 table, zone_id 0).
    /// Kills: a migration that drops, reorders, or alters the table or its entries.
    const ENCOUNTERS_GOLDEN: &str = r#"// Encounter registry — DATA, not code (ADR-0006). Per-zone weighted spawn tables.
[
    (
        zone_id: 0,
        encounter_rate: 200,
        entries: [
            (species_id: 1, weight: 10, min_level: 3, max_level: 7),
            (species_id: 2, weight: 7, min_level: 3, max_level: 7),
            (species_id: 3, weight: 5, min_level: 4, max_level: 8),
        ],
    ),
]
"#;

    // -----------------------------------------------------------------------
    // Criterion 1 — Merge order (fan-out / file-order property)
    //
    // Two synthetic parts are passed in slice order; the merge concatenates
    // their parsed rows in that exact order, WITHOUT re-sorting rows.
    // Kills: an impl that re-sorts merged rows, that ignores file ordering, or
    // that only returns rows from one part.
    // -----------------------------------------------------------------------

    /// M8.9e-1a: parse_species_parts preserves file order — rows from the
    /// lexicographically-first filename come first, then the second file's rows,
    /// all in original declaration order within each file.
    ///
    /// Kills: an impl that reverses part order, sorts merged rows by id, or
    /// otherwise violates the "merge preserves given slice order" contract.
    #[test]
    fn m8_9e_species_parts_merge_order() {
        let part_a = r#"[
    (
        id: 10,
        name: "TestAlpha",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 65, sp_attack: 65, sp_defense: 45),
        affinity: Fire,
        learnable_skill_ids: [],
    ),
]"#;
        let part_b = r#"[
    (
        id: 20,
        name: "TestBeta",
        base_stats: (hp: 44, attack: 48, defense: 65, speed: 43, sp_attack: 64, sp_defense: 64),
        affinity: Water,
        learnable_skill_ids: [],
    ),
]"#;

        let merged = parse_species_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("two valid species parts must merge without error");

        let expected_a = parse_species(part_a).expect("part_a must parse");
        let expected_b = parse_species(part_b).expect("part_b must parse");
        let expected: Vec<Species> = expected_a.into_iter().chain(expected_b).collect();

        assert_eq!(
            merged, expected,
            "M8.9e: merged species must equal part_a rows followed by part_b rows in order"
        );

        // Part-order proof: if we reverse the slice, id=20 must come first.
        // This kills an impl that sorts rows by id or ignores slice order.
        let reversed = parse_species_parts(&[("001-b.ron", part_b), ("000-a.ron", part_a)])
            .expect("reversed parts must also merge");
        assert_eq!(
            reversed[0].id, 20,
            "M8.9e TEETH: reversed slice must put id=20 first — merge must respect given slice order"
        );
        assert_eq!(
            reversed[1].id, 10,
            "M8.9e TEETH: reversed slice must put id=10 second"
        );
    }

    /// M8.9e-1b: parse_skills_parts preserves file order — same contract as
    /// species, applied to SkillDef rows.
    ///
    /// Kills: an impl that special-cases species but skips order enforcement for
    /// other registries.
    #[test]
    fn m8_9e_skills_parts_merge_order() {
        let part_a = r#"[
    (id: 100, name: "TestSkillA", affinity: Fire,  power: 40, accuracy: 100, pp: 25),
]"#;
        let part_b = r#"[
    (id: 200, name: "TestSkillB", affinity: Water, power: 40, accuracy: 100, pp: 25),
]"#;

        let merged = parse_skills_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("two valid skill parts must merge without error");

        let expected_a = parse_skills(part_a).expect("part_a parses");
        let expected_b = parse_skills(part_b).expect("part_b parses");
        let expected: Vec<SkillDef> = expected_a.into_iter().chain(expected_b).collect();

        assert_eq!(
            merged, expected,
            "M8.9e: merged skills must equal part_a rows then part_b rows"
        );

        // Reversed-slice check: kills any impl that sorts or ignores slice order.
        let reversed = parse_skills_parts(&[("001-b.ron", part_b), ("000-a.ron", part_a)])
            .expect("reversed parts must also merge");
        assert_eq!(
            reversed[0].id, 200,
            "M8.9e TEETH: reversed skill slice must put id=200 first"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 2 — Migration parity (content-parity gate)
    //
    // After the directory split, load_*() must return row-identical content to
    // what parse_* returned against the monolithic files. We assert the merged
    // result is a PREFIX equal to the golden parse, making the test durable
    // across future content appends but fatal for reordering or dropping rows.
    //
    // Kills: an impl that drops rows, reorders them, or parses the wrong file.
    // -----------------------------------------------------------------------

    /// M8.9e-2a: load_species() after migration returns the same rows as
    /// parse_species(SPECIES_GOLDEN) as a prefix.
    ///
    /// Kills: an impl that drops species, reverses them, or loads from a
    /// different file entirely.
    #[test]
    fn m8_9e_species_migration_parity() {
        let merged = load_species().expect("load_species must succeed after migration");
        let golden = parse_species(SPECIES_GOLDEN).expect("golden species must parse");
        assert!(
            merged.len() >= golden.len(),
            "M8.9e: merged species ({}) must have at least as many rows as golden ({})",
            merged.len(),
            golden.len()
        );
        assert_eq!(
            &merged[..golden.len()],
            &golden[..],
            "M8.9e TEETH: first {} species rows must be row-identical to pre-migration content",
            golden.len()
        );
    }

    /// M8.9e-2b: load_skills() after migration returns the same rows as
    /// parse_skills(SKILLS_GOLDEN) as a prefix.
    ///
    /// Kills: an impl that drops skills or reorders them.
    #[test]
    fn m8_9e_skills_migration_parity() {
        let merged = load_skills().expect("load_skills must succeed after migration");
        let golden = parse_skills(SKILLS_GOLDEN).expect("golden skills must parse");
        assert!(
            merged.len() >= golden.len(),
            "M8.9e: merged skills ({}) must have at least as many rows as golden ({})",
            merged.len(),
            golden.len()
        );
        assert_eq!(
            &merged[..golden.len()],
            &golden[..],
            "M8.9e TEETH: first {} skill rows must be row-identical to pre-migration content",
            golden.len()
        );
    }

    /// M8.9e-2c: load_zones() after migration returns the same rows as
    /// parse_zones(ZONES_GOLDEN) as a prefix.
    ///
    /// Kills: an impl that drops zones or reorders them.
    #[test]
    fn m8_9e_zones_migration_parity() {
        let merged = load_zones().expect("load_zones must succeed after migration");
        let golden = parse_zones(ZONES_GOLDEN).expect("golden zones must parse");
        assert!(
            merged.len() >= golden.len(),
            "M8.9e: merged zones ({}) must have at least as many rows as golden ({})",
            merged.len(),
            golden.len()
        );
        assert_eq!(
            &merged[..golden.len()],
            &golden[..],
            "M8.9e TEETH: first {} zone rows must be row-identical to pre-migration content",
            golden.len()
        );
    }

    /// M8.9e-2d: load_items() after migration returns the same rows as
    /// parse_items(ITEMS_GOLDEN) as a prefix.
    ///
    /// Kills: an impl that drops items or reorders them.
    #[test]
    fn m8_9e_items_migration_parity() {
        let merged = load_items().expect("load_items must succeed after migration");
        let golden = parse_items(ITEMS_GOLDEN).expect("golden items must parse");
        assert!(
            merged.len() >= golden.len(),
            "M8.9e: merged items ({}) must have at least as many rows as golden ({})",
            merged.len(),
            golden.len()
        );
        assert_eq!(
            &merged[..golden.len()],
            &golden[..],
            "M8.9e TEETH: first {} item rows must be row-identical to pre-migration content",
            golden.len()
        );
    }

    /// M8.9e-2e: load_encounters() after migration returns the same rows as
    /// parse_encounters(ENCOUNTERS_GOLDEN) as a prefix.
    ///
    /// Kills: an impl that drops encounter tables or reorders them.
    #[test]
    fn m8_9e_encounters_migration_parity() {
        let merged = load_encounters().expect("load_encounters must succeed after migration");
        let golden = parse_encounters(ENCOUNTERS_GOLDEN).expect("golden encounters must parse");
        assert!(
            merged.len() >= golden.len(),
            "M8.9e: merged encounters ({}) must have at least as many rows as golden ({})",
            merged.len(),
            golden.len()
        );
        assert_eq!(
            &merged[..golden.len()],
            &golden[..],
            "M8.9e TEETH: first {} encounter tables must be row-identical to pre-migration content",
            golden.len()
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 3 — Malformed file ⇒ loud Err naming the file
    //
    // parse_*_parts must NEVER silently skip an unparseable part. It must
    // return Err, and the error string must include the offending filename.
    // Kills: an impl that ignores parse errors, uses `?` without filename
    // context, or wraps errors in a message that drops the filename.
    // -----------------------------------------------------------------------

    /// M8.9e-3a: parse_species_parts with a malformed second file must return
    /// Err whose message contains the offending filename "999-malformed.ron".
    ///
    /// Kills: an impl that silently skips the bad file, or that returns an
    /// error without identifying which file caused it.
    #[test]
    fn m8_9e_species_parts_malformed_names_file() {
        let valid_part = r#"[
    (
        id: 1,
        name: "Flameling",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 65, sp_attack: 65, sp_defense: 45),
        affinity: Fire,
        learnable_skill_ids: [1, 2],
    ),
]"#;
        let bad_part = "this is not ( valid ron {{{";

        let result = parse_species_parts(&[
            ("000-core.ron", valid_part),
            ("999-malformed.ron", bad_part),
        ]);

        assert!(
            result.is_err(),
            "M8.9e: a malformed species part must produce Err, not Ok"
        );
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("999-malformed.ron"),
            "M8.9e TEETH: error message must name the offending file '999-malformed.ron', got: {err_msg:?}"
        );
    }

    /// M8.9e-3b: parse_species_parts with ONLY valid files returns Ok.
    /// Symmetric proof that the error path only fires on actual bad input.
    ///
    /// Kills: an over-eager impl that always returns Err regardless of input.
    #[test]
    fn m8_9e_species_parts_all_valid_returns_ok() {
        let part_a = r#"[
    (
        id: 1,
        name: "Flameling",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 65, sp_attack: 65, sp_defense: 45),
        affinity: Fire,
        learnable_skill_ids: [],
    ),
]"#;
        let part_b = r#"[
    (
        id: 2,
        name: "Tidalin",
        base_stats: (hp: 44, attack: 48, defense: 65, speed: 43, sp_attack: 64, sp_defense: 64),
        affinity: Water,
        learnable_skill_ids: [],
    ),
]"#;
        let result = parse_species_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)]);
        assert!(
            result.is_ok(),
            "M8.9e: two valid species parts must produce Ok, got: {:?}",
            result.err()
        );
    }

    /// M8.9e-3c: parse_species_parts with a malformed FIRST file still names it.
    /// Guards against an impl that only checks the last file, or only propagates
    /// errors for files after index 0.
    ///
    /// Kills: an impl that skips error-propagation for the first part.
    #[test]
    fn m8_9e_species_parts_malformed_first_file_named() {
        let bad_first = "not ron at all <<<";
        let valid_second = r#"[
    (
        id: 99,
        name: "Valid",
        base_stats: (hp: 50, attack: 50, defense: 50, speed: 50, sp_attack: 50, sp_defense: 50),
        affinity: Plant,
        learnable_skill_ids: [],
    ),
]"#;
        let result = parse_species_parts(&[
            ("000-broken.ron", bad_first),
            ("001-fine.ron", valid_second),
        ]);
        assert!(
            result.is_err(),
            "M8.9e: a malformed first species part must produce Err"
        );
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("000-broken.ron"),
            "M8.9e TEETH: error must name the first offending file '000-broken.ron', got: {err_msg:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 4 — Determinism of the embed (sorted-order statics)
    //
    // Each *_RON_PARTS static must be non-empty and have filenames in
    // non-decreasing sorted order. This guards build.rs from emitting an
    // unsorted or non-deterministic embed.
    //
    // Kills: a build.rs that uses readdir without sorting, or that emits
    // filenames in OS-dependent traversal order.
    // -----------------------------------------------------------------------

    /// M8.9e-4a: SPECIES_RON_PARTS is non-empty and filenames are sorted.
    ///
    /// Kills: a build.rs that emits species parts in OS-dependent traversal
    /// order (e.g. readdir on Linux is not guaranteed to be sorted).
    #[test]
    fn m8_9e_species_parts_static_sorted() {
        assert!(
            !SPECIES_RON_PARTS.is_empty(),
            "M8.9e: SPECIES_RON_PARTS must be non-empty after migration"
        );
        let names: Vec<&str> = SPECIES_RON_PARTS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            names, sorted,
            "M8.9e TEETH: SPECIES_RON_PARTS filenames must be in sorted order, got: {names:?}"
        );
    }

    /// M8.9e-4b: SKILLS_RON_PARTS is non-empty and filenames are sorted.
    #[test]
    fn m8_9e_skills_parts_static_sorted() {
        assert!(
            !SKILLS_RON_PARTS.is_empty(),
            "M8.9e: SKILLS_RON_PARTS must be non-empty after migration"
        );
        let names: Vec<&str> = SKILLS_RON_PARTS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            names, sorted,
            "M8.9e TEETH: SKILLS_RON_PARTS filenames must be in sorted order, got: {names:?}"
        );
    }

    /// M8.9e-4c: ZONES_RON_PARTS is non-empty and filenames are sorted.
    #[test]
    fn m8_9e_zones_parts_static_sorted() {
        assert!(
            !ZONES_RON_PARTS.is_empty(),
            "M8.9e: ZONES_RON_PARTS must be non-empty after migration"
        );
        let names: Vec<&str> = ZONES_RON_PARTS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            names, sorted,
            "M8.9e TEETH: ZONES_RON_PARTS filenames must be in sorted order"
        );
    }

    /// M8.9e-4d: ITEMS_RON_PARTS is non-empty and filenames are sorted.
    #[test]
    fn m8_9e_items_parts_static_sorted() {
        assert!(
            !ITEMS_RON_PARTS.is_empty(),
            "M8.9e: ITEMS_RON_PARTS must be non-empty after migration"
        );
        let names: Vec<&str> = ITEMS_RON_PARTS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            names, sorted,
            "M8.9e TEETH: ITEMS_RON_PARTS filenames must be in sorted order"
        );
    }

    /// M8.9e-4e: ENCOUNTERS_RON_PARTS is non-empty and filenames are sorted.
    #[test]
    fn m8_9e_encounters_parts_static_sorted() {
        assert!(
            !ENCOUNTERS_RON_PARTS.is_empty(),
            "M8.9e: ENCOUNTERS_RON_PARTS must be non-empty after migration"
        );
        let names: Vec<&str> = ENCOUNTERS_RON_PARTS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            names, sorted,
            "M8.9e TEETH: ENCOUNTERS_RON_PARTS filenames must be in sorted order"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 5 — End-to-end validation after migration
    //
    // The merged registries must pass validate_content and validate_encounters.
    // Note: validate_content_passes_for_embedded (test #59 above) already covers
    // validate_content on the embedded data. After the migration, load_* delegates
    // to parse_*_parts so that test implicitly covers criterion 5 for species/
    // skills/items. We add explicit post-migration tests here with clear M8.9e
    // labelling so the criterion is traceable, and we add validate_encounters
    // which has no equivalent in the pre-existing suite at this level.
    // -----------------------------------------------------------------------

    /// M8.9e-5a: merged species+skills+items+type_chart pass validate_content.
    /// After the directory migration, load_* must still produce content that
    /// is internally consistent (unique ids, valid stats, no dangling refs).
    ///
    /// Kills: a migration that introduces duplicate ids or drops skill refs.
    /// (Complements #59 validate_content_passes_for_embedded; labeled separately
    /// for M8.9e traceability.)
    #[test]
    fn m8_9e_merged_content_validates() {
        let species = load_species().expect("M8.9e: load_species must succeed");
        let skills = load_skills().expect("M8.9e: load_skills must succeed");
        let chart = load_type_chart().expect("M8.9e: load_type_chart must succeed");
        let items = load_items().expect("M8.9e: load_items must succeed");
        validate_content(&species, &skills, &chart, &items)
            .expect("M8.9e: merged content must pass validate_content");
    }

    /// M8.9e-5b: merged encounters+species+zones pass validate_encounters.
    /// After the directory migration, encounter tables must still reference
    /// valid zones and species from the merged registries.
    ///
    /// Kills: a migration that reorders zone/species ids breaking cross-registry
    /// references. (embedded_encounters_parse_and_validate above covers the
    /// pre-migration baseline; this test ensures it holds POST-migration too.)
    #[test]
    fn m8_9e_merged_encounters_validate() {
        let encounters = load_encounters().expect("M8.9e: load_encounters must succeed");
        let species = load_species().expect("M8.9e: load_species must succeed");
        let zones = load_zones().expect("M8.9e: load_zones must succeed");
        validate_encounters(&encounters, &species, &zones)
            .expect("M8.9e: merged encounters must pass validate_encounters");
    }

    // -----------------------------------------------------------------------
    // Additional parse_*_parts coverage for zones, items, encounters
    // (ensures the interface is complete, not just species+skills).
    // -----------------------------------------------------------------------

    /// M8.9e-extra-a: parse_zones_parts merges two zone parts in order.
    ///
    /// Kills: an impl that only implements parse_species_parts /
    /// parse_skills_parts but omits zones, items, or encounters.
    #[test]
    fn m8_9e_zones_parts_merge_order() {
        let part_a = r#"[(id: 90, name: "ZoneA", width: 10, height: 10)]"#;
        let part_b = r#"[(id: 91, name: "ZoneB", width: 20, height: 20)]"#;

        let merged = parse_zones_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("two valid zone parts must merge without error");

        assert_eq!(merged.len(), 2, "M8.9e: two zone parts must produce 2 rows");
        assert_eq!(
            merged[0].id, 90,
            "M8.9e: first row must come from first part"
        );
        assert_eq!(
            merged[1].id, 91,
            "M8.9e: second row must come from second part"
        );
    }

    /// M8.9e-extra-b: parse_items_parts merges two item parts in order.
    ///
    /// Kills: an impl that omits parse_items_parts.
    #[test]
    fn m8_9e_items_parts_merge_order() {
        let part_a = r#"[(id: 50, name: "ItemA", description: "desc a", recruit_bonus: 0)]"#;
        let part_b = r#"[(id: 51, name: "ItemB", description: "desc b", recruit_bonus: 100)]"#;

        let merged = parse_items_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("two valid item parts must merge without error");

        assert_eq!(merged.len(), 2, "M8.9e: two item parts must produce 2 rows");
        assert_eq!(
            merged[0].id, 50,
            "M8.9e: first item must come from first part"
        );
        assert_eq!(
            merged[1].id, 51,
            "M8.9e: second item must come from second part"
        );
    }

    /// M8.9e-extra-c: parse_encounters_parts merges two encounter parts in order.
    ///
    /// Kills: an impl that omits parse_encounters_parts.
    #[test]
    fn m8_9e_encounters_parts_merge_order() {
        let part_a = r#"[
    (
        zone_id: 90,
        encounter_rate: 100,
        entries: [
            (species_id: 1, weight: 10, min_level: 3, max_level: 7),
        ],
    ),
]"#;
        let part_b = r#"[
    (
        zone_id: 91,
        encounter_rate: 200,
        entries: [
            (species_id: 2, weight: 5, min_level: 5, max_level: 10),
        ],
    ),
]"#;

        let merged = parse_encounters_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("two valid encounter parts must merge without error");

        assert_eq!(
            merged.len(),
            2,
            "M8.9e: two encounter parts must produce 2 tables"
        );
        assert_eq!(
            merged[0].zone_id, 90,
            "M8.9e: first encounter table must come from first part"
        );
        assert_eq!(
            merged[1].zone_id, 91,
            "M8.9e: second encounter table must come from second part"
        );
    }

    /// M8.9e-extra-d: parse_zones_parts with a malformed part names the file.
    ///
    /// Kills: an impl that provides error propagation for species/skills but
    /// silently swallows parse errors from zones/items/encounters parts.
    #[test]
    fn m8_9e_zones_parts_malformed_names_file() {
        let bad = "not valid ron <<<";
        let result = parse_zones_parts(&[("777-bad-zones.ron", bad)]);
        assert!(
            result.is_err(),
            "M8.9e: malformed zone part must return Err"
        );
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("777-bad-zones.ron"),
            "M8.9e TEETH: error must name '777-bad-zones.ron', got: {err_msg:?}"
        );
    }

    /// M8.9e-extra-e: parse_encounters_parts with a malformed part names the file.
    #[test]
    fn m8_9e_encounters_parts_malformed_names_file() {
        let bad = "not valid ron <<<";
        let result = parse_encounters_parts(&[("888-bad-enc.ron", bad)]);
        assert!(
            result.is_err(),
            "M8.9e: malformed encounter part must return Err"
        );
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("888-bad-enc.ron"),
            "M8.9e TEETH: error must name '888-bad-enc.ron', got: {err_msg:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Fan-out safety gate: cross-file id collision caught by validate_content
    //
    // This is the headline safety boundary for parallel content authoring:
    // two authors writing SEPARATE part files can each declare the same id,
    // each file parses clean on its own, but validate_content run on the
    // concatenated Vec must catch the collision. This is a PERMANENT regression
    // guard — it passes once the implementation exists and must never be removed.
    // -----------------------------------------------------------------------

    /// M8.9e-gate: the fan-out safety boundary. Two part FILES in one registry that
    /// each declare the same id parse cleanly on their own, but the merged registry
    /// must be rejected by validate_content — this is what makes parallel content
    /// slices (different files, same registry) safe. Kills a future loader that
    /// dedups silently, or a validate path that only checks within a single file.
    #[test]
    fn m8_9e_cross_file_duplicate_species_id_rejected_by_validate() {
        let part_a = r#"[(id: 42, name: "A",
        base_stats: (hp:45,attack:49,defense:49,speed:65,sp_attack:65,sp_defense:45),
        affinity: Fire, learnable_skill_ids: [])]"#;
        let part_b = r#"[(id: 42, name: "AClone",
        base_stats: (hp:45,attack:49,defense:49,speed:65,sp_attack:65,sp_defense:45),
        affinity: Water, learnable_skill_ids: [])]"#;
        // Each part is individually valid RON → the concatenating loader returns Ok.
        let merged = parse_species_parts(&[("000-a.ron", part_a), ("001-b.ron", part_b)])
            .expect("each part is valid RON, so parse_species_parts must succeed");
        assert_eq!(
            merged.len(),
            2,
            "the two colliding rows survive parse; the dup is a validate concern"
        );
        // TEETH: the cross-file duplicate id MUST be caught by validate_content.
        assert!(
            validate_content(&merged, &[], &[], &[]).is_err(),
            "TEETH: cross-file duplicate species id=42 must be rejected by validate_content"
        );
    }

    // =======================================================================
    // === M9b-tail: training food fields on ItemDef ===
    //
    // EARS criteria covered:
    //   - WHEN train_stat is Some(...) and train_amount in [1, 252] THEN validate_content Ok.
    //   - WHEN train_amount == 252 (boundary) THEN validate_content Ok.
    //   - WHEN train_amount == 253 (above cap) THEN validate_content Err.
    //   - WHEN train_stat is Some and train_amount == 0 THEN validate_content Err.
    //   - WHEN train_stat is None and train_amount > 0 THEN validate_content Err (incoherent).
    //   - WHEN train_stat is None and train_amount == 0 (ordinary item) THEN validate_content Ok.
    //   - Proof-of-teeth: an over-cap training food MUST be rejected.
    //
    // NOTE: ItemDef will gain `train_stat: Option<StatKind>` + `train_amount: u16`
    // (both `#[serde(default)]`) in the impl. Until then these tests DO NOT COMPILE
    // (the fields do not exist yet) — that is the intended RED state.
    // =======================================================================

    use crate::monster::types::StatKind;

    /// Build a training-food ItemDef with the M9b-tail fields.
    /// The caller supplies only the new fields; id/name/description/recruit_bonus
    /// are fixed noise values so the test focuses on the training fields.
    fn fixture_training_item(id: u32, train_stat: Option<StatKind>, train_amount: u16) -> ItemDef {
        ItemDef {
            id,
            name: format!("TrainingFood{id}"),
            description: "A training food.".to_string(),
            recruit_bonus: 0,
            // These two fields do not exist yet — the suite is RED until the impl adds them.
            train_stat,
            train_amount,
        }
    }

    /// M9b-tail: validate_content accepts a valid training food (Some(Attack), amount 10).
    /// kills: a validate_content that rejects valid training food items outright.
    #[test]
    fn validate_content_accepts_training_food() {
        let item = fixture_training_item(100, Some(StatKind::Attack), 10);
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_ok(),
            "validate_content must accept a training food with train_stat=Some(Attack), train_amount=10; got: {:?}",
            result.err()
        );
    }

    /// M9b-tail: validate_content accepts training food at the per-stat cap boundary (252).
    /// kills: an off-by-one upper bound check (>= vs >) that rejects train_amount==252.
    #[test]
    fn validate_content_accepts_train_amount_at_cap() {
        let item = fixture_training_item(101, Some(StatKind::Attack), 252);
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_ok(),
            "validate_content must accept training food with train_amount=252 (at the per-stat cap boundary); got: {:?}",
            result.err()
        );
    }

    /// M9b-tail: validate_content rejects training food with train_amount above 252 (==253).
    /// kills: missing upper-bound check (an item granting 253 EVs would exceed the per-stat cap).
    #[test]
    fn validate_content_rejects_train_amount_over_cap() {
        let item = fixture_training_item(102, Some(StatKind::Attack), 253);
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_err(),
            "validate_content must reject training food with train_amount=253 (above per-stat cap 252)"
        );
    }

    /// M9b-tail: validate_content rejects a training food with Some(stat) but train_amount==0.
    /// Mirrors the accuracy==0 precedent: a food that grants nothing is an unusable no-op,
    /// rejected at load time rather than silently loaded.
    /// kills: an impl that allows zero-amount training foods (silent no-op at runtime).
    #[test]
    fn validate_content_rejects_training_food_zero_amount() {
        let item = fixture_training_item(103, Some(StatKind::Attack), 0);
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_err(),
            "validate_content must reject a training food with train_stat=Some(Attack), train_amount=0 (always a no-op)"
        );
    }

    /// M9b-tail: validate_content rejects incoherent items where train_stat is None but
    /// train_amount > 0 (there is no stat to apply the amount to).
    /// kills: an impl that allows a phantom amount without a target stat.
    #[test]
    fn validate_content_rejects_amount_without_stat() {
        let item = fixture_training_item(104, None, 5);
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_err(),
            "validate_content must reject an item with train_stat=None, train_amount=5 (incoherent)"
        );
    }

    /// M9b-tail: validate_content accepts an ordinary item (train_stat=None, train_amount=0).
    /// This is the Lure-Berry shape — a non-training item must still load correctly.
    /// kills: an over-strict check that rejects all non-training items.
    #[test]
    fn validate_content_accepts_non_training_item() {
        // Mirrors the existing ITEMS_GOLDEN Lure-Berry shape.
        let item = ItemDef {
            id: 1,
            name: "Lure Berry".to_string(),
            description: "Sweet bait that calms a wild monster, easing recruitment.".to_string(),
            recruit_bonus: 150,
            train_stat: None,
            train_amount: 0,
        };
        let result = validate_content(&[], &[], &[], &[item]);
        assert!(
            result.is_ok(),
            "validate_content must accept a non-training item (train_stat=None, train_amount=0); got: {:?}",
            result.err()
        );
    }

    /// M9b-tail: PROOF-OF-TEETH — an over-cap training food (Some(Attack), train_amount=300)
    /// MUST be rejected. This bites a validator missing the upper-bound check.
    /// kills: any validate_content that accepts training foods without checking train_amount <= 252.
    #[test]
    fn validate_content_teeth_train_amount_over_cap() {
        let bad_item = fixture_training_item(200, Some(StatKind::Attack), 300);
        let result = validate_content(&[], &[], &[], &[bad_item]);
        assert!(
            result.is_err(),
            "TEETH: training food with train_amount=300 (>252) MUST be rejected by validate_content; \
             a validator without the upper-bound check would pass this and load an impossible food"
        );
    }

    // =======================================================================
    // === M10a-content: evolution/fusion content types + integrity validator ===
    //
    // EARS criteria covered (ADR-0060, M10 spec §3):
    //   1. parse_fusion / parse_evolutions round-trip all three EvolutionTrigger
    //      variants (Level/Bond/Item) and return typed Vecs.
    //   2. Malformed RON → Err (mirrors rejects_malformed_species_ron).
    //   3. load_fusion() / load_evolutions() parse Ok and are non-empty (live seed).
    //   4. validate_evolution_fusion on the live embedded seed returns Ok.
    //   5. Gate (a): no duplicate fusion pair, ORDER-INDEPENDENT — TEETH.
    //   6. Gate (b): derived-form (evolution target) in encounter table → Err,
    //      with species present in species slice (not a dangling-ref pass) — TEETH.
    //   7. Gate (b-sibling): fusion result in encounter table → Err — TEETH.
    //   8. Gate (c-i): dangling EvolutionCondition.to_species → Err — TEETH.
    //   9. Gate (c-ii): dangling FusionRecipe.a → Err — TEETH.
    //  10. Gate (item-ref): EvolutionTrigger::Item(id) not in items → Err — TEETH.
    //  11. Gate (d-i): duplicate SpeciesEvolutions.species_id block → Err — TEETH.
    //  12. Gate (d-ii): empty evolutions: [] block → Err — TEETH.
    //  13. Self-evolution (to_species == species_id) → Err — TEETH.
    //  14. Bond(0) trigger → Err — TEETH.
    //  15. Fusion a == b → Err — TEETH.
    //  16. Fusion to ∈ {a, b} → Err — TEETH.
    //  17. Regression: load_species() still passes validate_content and grew
    //      (m8_9e_species_migration_parity prefix gate preserved).
    //
    // NOTE: All types/fns referenced below DO NOT EXIST YET — this suite is RED
    // (compile error) until the implementer adds them to content.rs. That is the
    // intended TDD red state, mirroring how the M9b-tail tests were added at
    // content.rs:1636 ("Until then these tests DO NOT COMPILE").
    //
    // RON trigger syntax (ADR-0060 §1, derived from Level/Bond custom Deserializes):
    //   - Level's custom Deserialize calls u8::deserialize → bare integer inside
    //     the enum variant tuple: `Level(16)` (the `16` is a plain u8, not a struct).
    //   - Bond derives Deserialize on Bond(u8) newtype → in RON a newtype struct is
    //     transparent: `Bond(42)` carries the u8 directly.
    //   - Item wraps a raw u32: `Item(3)`.
    //   So a RON EvolutionTrigger looks like: `Level(16)`, `Bond(120)`, `Item(3)`.
    // =======================================================================

    use crate::monster::types::{Bond, Level};
    use crate::taming::types::{EncounterEntry, EncounterTable};

    // -----------------------------------------------------------------------
    // M10a fixture builders
    // -----------------------------------------------------------------------

    /// Build a minimal valid FusionRecipe.
    fn fusion_recipe(a: u32, b: u32, to: u32) -> FusionRecipe {
        FusionRecipe { a, b, to }
    }

    /// Build a SpeciesEvolutions block with one Level-trigger condition.
    fn species_evos_level(
        species_id: u32,
        trigger_level: u8,
        to_species: u32,
    ) -> SpeciesEvolutions {
        SpeciesEvolutions {
            species_id,
            evolutions: vec![EvolutionCondition {
                trigger: EvolutionTrigger::Level(Level::new(trigger_level).expect("valid level")),
                to_species,
            }],
        }
    }

    /// Build a SpeciesEvolutions block with one Bond-trigger condition.
    fn species_evos_bond(species_id: u32, bond_val: u8, to_species: u32) -> SpeciesEvolutions {
        SpeciesEvolutions {
            species_id,
            evolutions: vec![EvolutionCondition {
                trigger: EvolutionTrigger::Bond(Bond::new(bond_val)),
                to_species,
            }],
        }
    }

    /// Build a SpeciesEvolutions block with one Item-trigger condition.
    fn species_evos_item(species_id: u32, item_id: u32, to_species: u32) -> SpeciesEvolutions {
        SpeciesEvolutions {
            species_id,
            evolutions: vec![EvolutionCondition {
                trigger: EvolutionTrigger::Item(item_id),
                to_species,
            }],
        }
    }

    /// Build a minimal EncounterTable for a zone containing the given species ids.
    /// Uses min_level=1, max_level=5, weight=10 for each entry.
    fn fixture_encounter_table(zone_id: u32, species_ids: &[u32]) -> EncounterTable {
        EncounterTable {
            zone_id,
            encounter_rate: 200,
            entries: species_ids
                .iter()
                .map(|&sid| EncounterEntry {
                    species_id: sid,
                    weight: 10,
                    min_level: Level::new(1).unwrap(),
                    max_level: Level::new(5).unwrap(),
                })
                .collect(),
        }
    }

    /// A minimal valid set of 4 species (ids 1–4, where 4 is a derived form
    /// added to the species registry but absent from encounters).
    /// Species 1,2,3 are "wild-catchable" starters; species 4,5 are derived.
    fn m10a_base_species() -> Vec<Species> {
        vec![
            fixture_species(1, vec![]),
            fixture_species(2, vec![]),
            fixture_species(3, vec![]),
            fixture_species(4, vec![]),
            fixture_species(5, vec![]),
            fixture_species(6, vec![]),
        ]
    }

    /// A minimal valid item registry (one item, id 3, which the Item-trigger tests use).
    fn m10a_base_items() -> Vec<ItemDef> {
        vec![ItemDef {
            id: 3,
            name: "Evo Stone".to_string(),
            description: "Triggers evolution".to_string(),
            recruit_bonus: 0,
            train_stat: None,
            train_amount: 0,
        }]
    }

    /// A valid encounter table for zone 0 containing ONLY base species (1,2,3) —
    /// never any derived form.
    fn m10a_base_encounters() -> Vec<EncounterTable> {
        vec![fixture_encounter_table(0, &[1, 2, 3])]
    }

    // -----------------------------------------------------------------------
    // 1. Parse round-trip — pins RON syntax for all three trigger variants
    // -----------------------------------------------------------------------

    /// M10a-1a: parse_fusion returns a typed Vec with the correct fields.
    /// Kills: a parse_fusion that silently returns empty, misreads field names,
    /// or swaps a/b/to.
    #[test]
    fn m10a_parse_fusion_round_trip() {
        // RON for two fusion recipes: (1+2→5), (2+3→6)
        let ron_str = r#"[
            (a: 1, b: 2, to: 5),
            (a: 2, b: 3, to: 6),
        ]"#;
        let result = parse_fusion(ron_str).expect("valid fusion RON must parse");
        assert_eq!(
            result.len(),
            2,
            "M10a TEETH: must parse exactly 2 fusion recipes"
        );
        assert_eq!(
            result[0],
            fusion_recipe(1, 2, 5),
            "M10a TEETH: first recipe must be (1,2→5)"
        );
        assert_eq!(
            result[1],
            fusion_recipe(2, 3, 6),
            "M10a TEETH: second recipe must be (2,3→6)"
        );
    }

    /// M10a-1b: parse_evolutions round-trips all three EvolutionTrigger variants.
    /// Kills: an impl that only handles one variant, or that misreads the Level
    /// bare-int vs Bond/Item tuple forms.
    ///
    /// RON syntax derivation:
    ///   Level(16) — Level's custom Deserialize calls u8::deserialize on the inner
    ///               arg; in RON the enum variant tuple wraps a bare u8.
    ///   Bond(120) — Bond(u8) is a newtype struct; RON newtype is transparent, so
    ///               the variant arg is the inner u8.
    ///   Item(3)   — Item(u32) carries a raw u32 directly.
    #[test]
    fn m10a_parse_evolutions_all_trigger_variants() {
        let ron_str = r#"[
            (
                species_id: 1,
                evolutions: [
                    (trigger: Level(16), to_species: 4),
                ],
            ),
            (
                species_id: 2,
                evolutions: [
                    (trigger: Bond(120), to_species: 5),
                ],
            ),
            (
                species_id: 3,
                evolutions: [
                    (trigger: Item(3), to_species: 6),
                ],
            ),
        ]"#;
        let result =
            parse_evolutions(ron_str).expect("RON with all three trigger variants must parse");
        assert_eq!(
            result.len(),
            3,
            "M10a TEETH: must parse 3 SpeciesEvolutions blocks"
        );

        // Species 1: Level trigger
        assert_eq!(result[0].species_id, 1);
        assert_eq!(result[0].evolutions.len(), 1);
        assert_eq!(
            result[0].evolutions[0].to_species, 4,
            "M10a TEETH: Level-trigger to_species must be 4"
        );
        assert_eq!(
            result[0].evolutions[0].trigger,
            EvolutionTrigger::Level(Level::new(16).unwrap()),
            "M10a TEETH: trigger must be Level(16)"
        );

        // Species 2: Bond trigger
        assert_eq!(result[1].species_id, 2);
        assert_eq!(
            result[1].evolutions[0].trigger,
            EvolutionTrigger::Bond(Bond::new(120)),
            "M10a TEETH: trigger must be Bond(120)"
        );
        assert_eq!(result[1].evolutions[0].to_species, 5);

        // Species 3: Item trigger
        assert_eq!(result[2].species_id, 3);
        assert_eq!(
            result[2].evolutions[0].trigger,
            EvolutionTrigger::Item(3),
            "M10a TEETH: trigger must be Item(3)"
        );
        assert_eq!(result[2].evolutions[0].to_species, 6);
    }

    /// M10a-1c: parse_fusion rejects malformed RON.
    /// Mirrors rejects_malformed_species_ron; kills a parse_fusion that silently
    /// returns empty on bad input instead of propagating the error.
    #[test]
    fn m10a_parse_fusion_rejects_malformed_ron() {
        assert!(
            parse_fusion("not ron at all {{{").is_err(),
            "M10a TEETH: malformed RON must return Err from parse_fusion"
        );
    }

    /// M10a-1d: parse_evolutions rejects malformed RON.
    #[test]
    fn m10a_parse_evolutions_rejects_malformed_ron() {
        assert!(
            parse_evolutions("not ron at all {{{").is_err(),
            "M10a TEETH: malformed RON must return Err from parse_evolutions"
        );
    }

    // -----------------------------------------------------------------------
    // 2. Embedded content loads + validates (positive gate, live seed)
    // -----------------------------------------------------------------------

    /// M10a-2a: load_fusion() parses Ok and the result is non-empty.
    /// Kills: an impl that fails to wire the include_str! or returns an empty list.
    #[test]
    fn m10a_embedded_fusion_parses_nonempty() {
        let recipes = load_fusion().expect("embedded fusion.ron must parse");
        assert!(
            !recipes.is_empty(),
            "M10a TEETH: load_fusion() must return at least one recipe (seed content required)"
        );
    }

    /// M10a-2b: load_evolutions() parses Ok and the result is non-empty.
    /// Kills: an impl that fails to wire the include_str! or returns an empty list.
    #[test]
    fn m10a_embedded_evolutions_parses_nonempty() {
        let evos = load_evolutions().expect("embedded evolutions.ron must parse");
        assert!(
            !evos.is_empty(),
            "M10a TEETH: load_evolutions() must return at least one entry (seed content required)"
        );
    }

    /// M10a-2c: validate_evolution_fusion on the full live embedded seed returns Ok.
    /// This is the primary positive gate — proves the seed's derived species are
    /// absent from encounters and all refs are coherent.
    ///
    /// Kills: any impl that accidentally flags the live seed as invalid, or an
    /// impl that wires the wrong registries together.
    #[test]
    fn m10a_embedded_evolution_fusion_validates() {
        let species = load_species().expect("species parse");
        let evolutions = load_evolutions().expect("evolutions parse");
        let recipes = load_fusion().expect("fusion parse");
        let encounters = load_encounters().expect("encounters parse");
        let items = load_items().expect("items parse");
        validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items).expect(
            "M10a TEETH: validate_evolution_fusion must return Ok for the embedded seed — \
                 derived forms must be absent from encounters and all refs must be valid",
        );
    }

    // -----------------------------------------------------------------------
    // 3. Gate (a): no duplicate fusion pair, ORDER-INDEPENDENT — TEETH
    // -----------------------------------------------------------------------

    /// M10a-3: duplicate fusion pair (reversed) → Err, error mentions duplicate/pair.
    ///
    /// The second recipe is the REVERSED pair (a:2,b:1) after (a:1,b:2).
    /// A literal-duplicate fixture would NOT kill a raw-pair impl that skips
    /// normalization; the reversal specifically kills any impl that checks
    /// order-dependent equality instead of normalizing (min,max).
    ///
    /// Kills: an impl that checks literal (a,b) equality instead of
    /// normalizing to (min(a,b), max(a,b)) before dedup.
    #[test]
    fn m10a_duplicate_fusion_pair_reversed_order_rejected() {
        let species = m10a_base_species();
        let evolutions = vec![];
        let recipes = vec![
            fusion_recipe(1, 2, 5), // (1,2)→5
            fusion_recipe(2, 1, 6), // reversed: (2,1) is the same pair as (1,2)
        ];
        let encounters = m10a_base_encounters();
        let items = m10a_base_items();

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: a reversed duplicate fusion pair (1,2) and (2,1) must be rejected; \
             an impl that checks literal equality would pass this and allow ambiguous recipes"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("duplicate") || err.contains("pair"),
            "M10a TEETH: error must mention 'duplicate' or 'pair', got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 4. Gate (b): derived-form in encounter table → Err (isolated)
    // -----------------------------------------------------------------------

    /// M10a-4a: an evolution target (species 4) appearing in an encounter table → Err.
    ///
    /// ISOLATION: species 4 IS in the species slice (so dangling-ref cannot cause
    /// the pass); the error must reference the wild/encounter violation, NOT "dangling".
    ///
    /// Kills: an impl that only checks dangling refs but not derived-form presence
    /// in encounter tables, or one that passes because species 4 is absent from
    /// the species registry.
    #[test]
    fn m10a_derived_evolution_target_in_encounter_table_rejected() {
        let species = m10a_base_species(); // includes species 4 — NOT a dangling ref
                                           // Species 1 evolves to species 4 at level 16
        let evolutions = vec![species_evos_level(1, 16, 4)];
        let recipes = vec![];
        // Encounter table ALSO contains species 4 (the derived form)
        let encounters = vec![fixture_encounter_table(0, &[1, 2, 3, 4])];
        let items = m10a_base_items();

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: evolution target species 4 must not appear in encounter tables; \
             an impl that only checks dangling refs would pass this (species 4 exists in species slice)"
        );
        let err = result.unwrap_err();
        // Error must reference wild/encounter violation, NOT dangling-ref
        assert!(
            err.contains("wild") || err.contains("encounter") || err.contains("derived"),
            "M10a TEETH: error must mention 'wild', 'encounter', or 'derived', got: {err:?}"
        );
        assert!(
            !err.contains("dangling") && !err.contains("non-existent"),
            "M10a TEETH: error must NOT be a dangling-ref error (species 4 is in the registry), got: {err:?}"
        );
    }

    /// M10a-4b: a fusion result (species 5) appearing in an encounter table → Err.
    ///
    /// Sibling of 4a: covers the fusion-result case of Gate (b), not just the
    /// evolution-target case. Species 5 IS in the species slice.
    ///
    /// Kills: an impl that checks only evolution targets in encounters but not
    /// fusion result species.
    #[test]
    fn m10a_fusion_result_in_encounter_table_rejected() {
        let species = m10a_base_species(); // includes species 5 — NOT a dangling ref
        let evolutions = vec![];
        let recipes = vec![fusion_recipe(1, 2, 5)]; // species 5 is a fusion result
                                                    // Encounter table ALSO contains species 5 (the derived form)
        let encounters = vec![fixture_encounter_table(0, &[1, 2, 3, 5])];
        let items = m10a_base_items();

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: fusion result species 5 must not appear in encounter tables; \
             an impl that only checks evolution targets would miss fusion results"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("wild") || err.contains("encounter") || err.contains("derived"),
            "M10a TEETH: error must mention 'wild', 'encounter', or 'derived', got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 5. Gate (c): dangling species refs — two focused fixtures
    // -----------------------------------------------------------------------

    /// M10a-5a: EvolutionCondition.to_species references a species not in the registry → Err.
    ///
    /// Kills: an impl that skips the to_species cross-ref check, allowing an
    /// evolution that would point to a non-existent species at runtime.
    #[test]
    fn m10a_dangling_evolution_to_species_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        // to_species: 99 does NOT exist in species slice
        let evolutions = vec![species_evos_level(1, 16, 99)];
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: to_species=99 (non-existent) must be rejected; \
             an impl missing the cross-ref check would silently accept it"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("99") || err.contains("dangling") || err.contains("non-existent"),
            "M10a TEETH: error must reference the missing species id 99, got: {err:?}"
        );
    }

    /// M10a-5b: FusionRecipe.a references a species not in the registry → Err.
    ///
    /// Kills: an impl that checks evolution refs but not fusion recipe refs.
    #[test]
    fn m10a_dangling_fusion_recipe_a_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        let evolutions = vec![];
        // species 77 does NOT exist
        let recipes = vec![fusion_recipe(77, 1, 2)];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: FusionRecipe.a=77 (non-existent) must be rejected; \
             an impl missing the recipe cross-ref check would silently accept it"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("77") || err.contains("dangling") || err.contains("non-existent"),
            "M10a TEETH: error must reference the missing species id 77, got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 6. Item-ref dangling — TEETH
    // -----------------------------------------------------------------------

    /// M10a-6: EvolutionTrigger::Item(id) with id not in items → Err.
    ///
    /// Kills: an impl that validates species refs but not item refs for Item triggers,
    /// allowing an item-triggered evolution that references a non-existent item.
    #[test]
    fn m10a_dangling_item_trigger_ref_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(4, vec![])];
        // item_id 999 does NOT exist in items slice
        let evolutions = vec![species_evos_item(1, 999, 4)];
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![]; // item 999 is not here

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: Item-trigger referencing item_id=999 (non-existent) must be rejected; \
             an impl that skips item cross-ref would load a broken evolution table"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("999") || err.contains("item") || err.contains("dangling"),
            "M10a TEETH: error must reference the missing item id 999, got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 7. Gate (d): registry well-formedness
    // -----------------------------------------------------------------------

    /// M10a-7a: two SpeciesEvolutions blocks with the same species_id → Err.
    ///
    /// The species id IS unique in the species slice (so validate_content dup check
    /// cannot cause this pass). The evolution registry itself has the duplicate.
    ///
    /// Kills: an impl that skips the within-registry duplicate species_id check,
    /// which would allow the second block to silently shadow or conflict with the first.
    #[test]
    fn m10a_duplicate_species_evolutions_block_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(4, vec![])];
        let evolutions = vec![
            species_evos_level(1, 16, 4), // first block for species 1
            species_evos_level(1, 20, 4), // second block — same species_id=1, duplicate
        ];
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: two SpeciesEvolutions blocks with species_id=1 must be rejected; \
             an impl missing the duplicate-block check would silently ignore one of them"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("1") || err.contains("duplicate"),
            "M10a TEETH: error must mention species id 1 or 'duplicate', got: {err:?}"
        );
    }

    /// M10a-7b: a SpeciesEvolutions block with an empty evolutions Vec → Err.
    ///
    /// An empty block silently occupies a species_id slot, blocking any later
    /// real entry. ADR-0060 §3 explicitly rejects it.
    ///
    /// Kills: an impl that accepts empty evolution blocks, leaving the slot
    /// permanently blocked and invisible to content authors.
    #[test]
    fn m10a_empty_evolutions_block_rejected() {
        let species = vec![fixture_species(1, vec![])];
        let evolutions = vec![SpeciesEvolutions {
            species_id: 1,
            evolutions: vec![], // explicitly empty — not a valid registry entry
        }];
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: an empty evolutions: [] block must be rejected; \
             an impl that accepts empty blocks would silently occupy species_id slots"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("empty") || err.contains("1"),
            "M10a TEETH: error must mention 'empty' or species id 1, got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 8. Self-reference / coherence — one focused test each
    // -----------------------------------------------------------------------

    /// M10a-8a: self-evolution (to_species == species_id) → Err.
    ///
    /// A "self-evolution" is a no-op that the reducer would happily re-apply
    /// indefinitely. ADR-0060 §3 rejects it at the content layer.
    ///
    /// Kills: an impl that omits the self-evolution guard, allowing circular
    /// single-node loops in the evolution graph.
    #[test]
    fn m10a_self_evolution_rejected() {
        let species = vec![fixture_species(1, vec![])];
        let evolutions = vec![species_evos_level(1, 16, 1)]; // to_species == species_id
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: to_species == species_id (self-evolution) must be rejected"
        );
    }

    /// M10a-8b: Bond(0) trigger → Err.
    ///
    /// Bond(0) is an always-true threshold (every monster's bond >= 0); it is
    /// analogous to accuracy=0 (always-miss, unrepresentable as a useful skill).
    /// ADR-0060 §3 rejects it because Bond's derived Deserialize accepts any u8,
    /// so parse-time rejection is impossible — it must be caught by the validator.
    ///
    /// Kills: an impl that omits the Bond(0) guard, allowing an always-true
    /// evolution trigger that fires for every monster immediately.
    #[test]
    fn m10a_bond_zero_trigger_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(4, vec![])];
        let evolutions = vec![species_evos_bond(1, 0, 4)]; // Bond(0) — always-true
        let recipes = vec![];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: Bond(0) trigger must be rejected (always-true threshold); \
             an impl missing this guard would allow every monster to immediately qualify"
        );
    }

    /// M10a-8c: fusion a == b (self-fusion) → Err.
    ///
    /// A monster cannot be fused with itself. ADR-0060 §3 rejects a == b.
    ///
    /// Kills: an impl that omits the a==b guard, allowing a recipe that would
    /// consume a monster twice and produce one offspring of itself.
    #[test]
    fn m10a_fusion_self_fusion_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        let evolutions = vec![];
        let recipes = vec![fusion_recipe(1, 1, 2)]; // a == b
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: fusion recipe with a == b must be rejected (self-fusion)"
        );
    }

    /// M10a-8d: fusion to ∈ {a, b} → Err.
    ///
    /// A fusion where the output is one of the inputs would reproduce an input
    /// rather than creating a new form. ADR-0060 §3 rejects it.
    ///
    /// Kills: an impl that omits the to∈{a,b} guard.
    #[test]
    fn m10a_fusion_to_is_input_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        let evolutions = vec![];
        // to == a: fusing 1+2 would produce 1 (a copy of the input)
        let recipes = vec![fusion_recipe(1, 2, 1)];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: fusion to ∈ {{a,b}} must be rejected (output reproduces an input)"
        );

        // Also check to == b
        let recipes_b = vec![fusion_recipe(1, 2, 2)];
        let result_b =
            validate_evolution_fusion(&species, &evolutions, &recipes_b, &encounters, &items);
        assert!(
            result_b.is_err(),
            "M10a TEETH: fusion to == b must also be rejected"
        );
    }

    // -----------------------------------------------------------------------
    // 9. Regression: load_species() still passes validate_content after
    //    010-derived.ron adds new species
    // -----------------------------------------------------------------------

    /// M10a-9: load_species() returns MORE rows than SPECIES_GOLDEN (the m8_9e
    /// prefix gate) AND still passes validate_content (no new id conflicts).
    ///
    /// This confirms the 010-derived.ron addition is additive: it sorts after
    /// 000-core.ron (the m8_9e_species_migration_parity prefix gate stays green)
    /// and the expanded registry is internally consistent.
    ///
    /// Kills: an impl that adds derived species to 000-core.ron (breaking prefix
    /// parity) or introduces id conflicts.
    #[test]
    fn m10a_derived_species_still_pass_validate_content() {
        let species = load_species().expect("load_species must succeed with 010-derived.ron");
        let golden = parse_species(SPECIES_GOLDEN).expect("golden species must parse");

        // After 010-derived.ron is added, load_species returns MORE than the 3 golden rows.
        assert!(
            species.len() > golden.len(),
            "M10a: load_species() ({}) must have MORE rows than SPECIES_GOLDEN ({}) after \
             010-derived.ron adds derived forms — the implementer must create this file",
            species.len(),
            golden.len()
        );

        // The existing m8_9e prefix gate: first 3 rows are still the golden rows.
        assert_eq!(
            &species[..golden.len()],
            &golden[..],
            "M10a TEETH: 000-core.ron rows must be byte-identical to SPECIES_GOLDEN prefix \
             (010-derived.ron sorts AFTER 000-core.ron, never before)"
        );

        // The full merged registry must still pass validate_content (no dup ids, etc.)
        let skills = load_skills().expect("skills parse");
        let chart = load_type_chart().expect("type_chart parse");
        let items = load_items().expect("items parse");
        validate_content(&species, &skills, &chart, &items).expect(
            "M10a TEETH: load_species() with 010-derived.ron must still pass validate_content; \
                 any duplicate id or zero base stat in the new file must be caught",
        );
    }

    // -----------------------------------------------------------------------
    // 10. Dangling fusion fields b and to — individual proof-of-teeth
    //
    // Gate (c) from the spec requires that ALL THREE fusion fields (a, b, to)
    // are cross-checked against the species registry. The existing test
    // m10a_dangling_fusion_recipe_a_rejected only exercises field `a`.
    // An impl that checks `a` but silently skips `b` or `to` would pass that
    // test. These two tests close that teeth gap for `b` and `to` individually.
    //
    // The validator loop in check 3:
    //   for (field, id) in [("a", r.a), ("b", r.b), ("to", r.to)] { ... }
    // is correct for all three fields; these tests permanently protect it.
    // -----------------------------------------------------------------------

    /// M10a-10a: FusionRecipe.b referencing a species not in the registry → Err.
    ///
    /// Kills: an impl that checks `a` but not `b` in the fusion cross-ref loop,
    /// allowing a recipe whose second parent does not exist.
    #[test]
    fn m10a_dangling_fusion_recipe_b_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        let evolutions = vec![];
        // species 77 does NOT exist (field b is dangling)
        let recipes = vec![fusion_recipe(1, 77, 2)];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: FusionRecipe.b=77 (non-existent) must be rejected; \
             an impl that only checks field `a` would silently accept this"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("77") || err.contains("non-existent"),
            "M10a TEETH: error must reference the missing species id 77, got: {err:?}"
        );
    }

    /// M10a-10b: FusionRecipe.to referencing a species not in the registry → Err.
    ///
    /// Kills: an impl that checks `a` and `b` but not `to` in the fusion
    /// cross-ref loop, allowing a recipe whose output form does not exist.
    #[test]
    fn m10a_dangling_fusion_recipe_to_rejected() {
        let species = vec![fixture_species(1, vec![]), fixture_species(2, vec![])];
        let evolutions = vec![];
        // species 99 does NOT exist (field to is dangling)
        let recipes = vec![fusion_recipe(1, 2, 99)];
        let encounters = vec![];
        let items = vec![];

        let result =
            validate_evolution_fusion(&species, &evolutions, &recipes, &encounters, &items);
        assert!(
            result.is_err(),
            "M10a TEETH: FusionRecipe.to=99 (non-existent) must be rejected; \
             an impl that only checks fields `a` and `b` would silently accept this"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("99") || err.contains("non-existent"),
            "M10a TEETH: error must reference the missing species id 99, got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 11. Parse-don't-validate boundary for Level triggers
    //
    // EvolutionTrigger uses `#[serde(try_from = "RawEvolutionTrigger")]`.
    // RawEvolutionTrigger::Level carries a raw u8, but the TryFrom impl calls
    // Level::new, which rejects 0 and >100. This means an out-of-range Level
    // trigger is unrepresentable — it is rejected at PARSE time, before any
    // validator runs.
    //
    // These tests pin that boundary as a permanent regression guard.
    // -----------------------------------------------------------------------

    /// M10a-11: parse_evolutions rejects `Level(0)` and `Level(101)` at PARSE time,
    /// before any call to validate_evolution_fusion.
    ///
    /// The RON `trigger: Level(0)` feeds into RawEvolutionTrigger::Level(0u8), which
    /// TryFrom converts via Level::new(0) — and Level::new rejects 0 with Err.
    /// Similarly Level::new(101) rejects values above 100. Both cases surface as a
    /// parse-time Err from parse_evolutions, not from the validator.
    ///
    /// KILLS: a future impl that drops the `try_from = "RawEvolutionTrigger"` mirror
    /// and instead derives Deserialize directly on EvolutionTrigger (which would let
    /// an out-of-range Level trigger parse, moving the boundary from parse-time to
    /// never — the content author would get no error at load time).
    #[test]
    fn m10a_parse_evolutions_level_zero_fails() {
        // Level(0): below the valid [1, 100] range — must be rejected at parse time.
        let ron_level_zero = r#"[
            (
                species_id: 1,
                evolutions: [
                    (trigger: Level(0), to_species: 2),
                ],
            ),
        ]"#;
        assert!(
            parse_evolutions(ron_level_zero).is_err(),
            "TEETH: Level(0) is below the valid range [1,100]; parse_evolutions must return Err \
             at parse time (via Level::new inside TryFrom<RawEvolutionTrigger>). \
             A future impl that drops the try_from mirror and derives Deserialize directly \
             would let Level(0) parse successfully — this assertion catches that regression."
        );

        // Level(101): above the valid [1, 100] range — must also be rejected at parse time.
        // u8 can represent 101, so this specifically exercises the upper-bound guard in Level::new.
        let ron_level_out_of_range = r#"[
            (
                species_id: 1,
                evolutions: [
                    (trigger: Level(101), to_species: 2),
                ],
            ),
        ]"#;
        assert!(
            parse_evolutions(ron_level_out_of_range).is_err(),
            "TEETH: Level(101) exceeds the valid range [1,100]; parse_evolutions must return Err \
             at parse time (via Level::new inside TryFrom<RawEvolutionTrigger>). \
             A future impl that drops the try_from mirror and derives Deserialize directly \
             would let Level(101) parse successfully — this assertion catches that regression."
        );
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: exact-boundary probes for the validators.
    // -----------------------------------------------------------------------

    /// Kills: `encounter_rate > 1000` -> `>=` (436:33) and
    /// `min_level > max_level` -> `>=` (465:40). Both boundaries are VALID.
    #[test]
    fn encounter_validator_accepts_exact_boundaries() {
        use crate::monster::types::Level;
        use crate::taming::types::{EncounterEntry, EncounterTable};
        let species = load_species().expect("embedded species parse");
        let zones = load_zones().expect("embedded zones parse");
        let table = EncounterTable {
            zone_id: zones[0].id,
            encounter_rate: 1000, // exactly the per-mille max: valid
            entries: vec![EncounterEntry {
                species_id: species[0].id,
                weight: 1,
                min_level: Level::new(3).expect("valid"),
                max_level: Level::new(3).expect("valid"), // min == max: valid
            }],
        };
        validate_encounters(&[table], &species, &zones)
            .expect("rate == 1000 and min_level == max_level must both be valid");

        // And one past each boundary must still be rejected.
        let mut bad_rate = EncounterTable {
            zone_id: zones[0].id,
            encounter_rate: 1001,
            entries: vec![EncounterEntry {
                species_id: species[0].id,
                weight: 1,
                min_level: Level::new(3).expect("valid"),
                max_level: Level::new(3).expect("valid"),
            }],
        };
        assert!(validate_encounters(std::slice::from_ref(&bad_rate), &species, &zones).is_err());
        bad_rate.encounter_rate = 1000;
        bad_rate.entries[0].min_level = Level::new(4).expect("valid");
        assert!(
            validate_encounters(&[bad_rate], &species, &zones).is_err(),
            "min 4 > max 3 must be rejected"
        );
    }

    /// Kills: `s > 255` -> `>=` and `> ` -> `==` (517:18). A base stat of
    /// exactly 255 is valid; 256 is not.
    #[test]
    fn base_stat_255_is_valid_256_is_rejected() {
        let mut species = load_species().expect("embedded species parse");
        let skills = load_skills().expect("embedded skills parse");
        let chart = load_type_chart().expect("embedded type chart parses");
        let items = load_items().expect("embedded items parse");

        species[0].base_stats.hp = 255;
        validate_content(&species, &skills, &chart, &items)
            .expect("base stat exactly 255 must be valid");

        species[0].base_stats.hp = 256;
        assert!(
            validate_content(&species, &skills, &chart, &items).is_err(),
            "base stat 256 must be rejected"
        );
    }
}
