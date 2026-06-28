//! Data-driven content: RON registries parsed by pure loaders
//! (parse-don't-validate). Content is DATA, not code — adding a zone is a content
//! edit + a validation test, never a rule change (ADR-0006). Stable ids are
//! append-only; the append-only-ids eval enforces the cross-version invariant.

use serde::Deserialize;

use crate::monster::types::{Affinity, StatBlock};
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
}
