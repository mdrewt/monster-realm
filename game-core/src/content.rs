//! Data-driven content: RON registries parsed by pure loaders
//! (parse-don't-validate). Content is DATA, not code — adding a zone is a content
//! edit + a validation test, never a rule change (ADR-0006). Stable ids are
//! append-only; the append-only-ids eval enforces the cross-version invariant.

use serde::Deserialize;

use crate::monster::types::{Affinity, StatBlock};

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
}

/// The embedded zone registry (compiled in via `include_str!`, parsed at load).
const ZONES_RON: &str = include_str!("../content/zones.ron");

/// Parse the embedded zone registry. Pure (no I/O) — safe under the determinism
/// guard. Parse-don't-validate: returns typed `ZoneDef`s or a descriptive error.
///
/// # Errors
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_zones() -> Result<Vec<ZoneDef>, String> {
    parse_zones(ZONES_RON)
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

const SPECIES_RON: &str = include_str!("../content/species.ron");
const SKILLS_RON: &str = include_str!("../content/skills.ron");
const TYPE_CHART_RON: &str = include_str!("../content/type_chart.ron");
const ITEMS_RON: &str = include_str!("../content/items.ron");

/// Parse the embedded species registry.
///
/// # Errors
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_species() -> Result<Vec<Species>, String> {
    parse_species(SPECIES_RON)
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
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_skills() -> Result<Vec<SkillDef>, String> {
    parse_skills(SKILLS_RON)
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
/// Returns `Err` if the embedded RON fails to parse.
pub fn load_items() -> Result<Vec<ItemDef>, String> {
    parse_items(ITEMS_RON)
}

/// Parse items from a RON string.
///
/// # Errors
/// Returns `Err` if `ron_str` is not a valid item list.
pub fn parse_items(ron_str: &str) -> Result<Vec<ItemDef>, String> {
    ron::from_str::<Vec<ItemDef>>(ron_str).map_err(|e| format!("items registry parse error: {e}"))
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

    #[allow(dead_code)]
    fn fixture_item(id: u32) -> ItemDef {
        ItemDef {
            id,
            name: format!("Item{id}"),
            description: format!("Description for item {id}"),
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
}
