//! Data-driven content: RON registries parsed by pure loaders
//! (parse-don't-validate). Content is DATA, not code — adding a zone is a content
//! edit + a validation test, never a rule change (ADR-0006). Stable ids are
//! append-only; the append-only-ids eval enforces the cross-version invariant.

use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::{load_zones, parse_zones, validate_zones};

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
        let dup = r#"[(id: 0, name: "A", width: 1, height: 1), (id: 0, name: "B", width: 1, height: 1)]"#;
        let zones = parse_zones(dup).expect("parses");
        assert!(validate_zones(&zones).is_err());
    }

    #[test]
    fn rejects_zero_dimension() {
        let bad = r#"[(id: 0, name: "Flat", width: 0, height: 5)]"#;
        let zones = parse_zones(bad).expect("parses");
        assert!(validate_zones(&zones).is_err());
    }
}
