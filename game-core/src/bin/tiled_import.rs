// tiled_import.rs — M11a: pure Tiled JSON → ZoneMapDef converter.
//
// This binary is a STUB. The `parse_tiled_json` function is declared with
// `todo!()` so the binary compiles (allowing the test suite below to be RED
// at runtime rather than failing to compile for a missing symbol). The
// implementation lands in the M11a feature slice.
//
// Architecture: std-only (~200-250 lines recursive-descent JSON parser).
// No serde_json dependency — game-core Cargo.toml must not gain new deps.
// GID convention: 0 = wall('#'), 1 = floor('.'), 2 = grass('~').
// Object layer "Warps": objects with to_zone, to_x, to_y int properties.

use game_core::content::{WarpDef, ZoneMapDef};
use game_core::types::TilePos;

/// Parse a Tiled JSON export (minimal subset) into a `ZoneMapDef`.
///
/// # Errors
/// Returns `Err` if:
/// - `json` is not valid JSON in the expected subset
/// - There is no `tilelayer` named "Tiles" (or any tilelayer)
/// - `data.len() != width * height`
/// - Any GID is not in {0, 1, 2}
/// - A "Warps" object layer has a malformed object or missing properties
pub fn parse_tiled_json(json: &str, zone_id: u32) -> Result<ZoneMapDef, String> {
    todo!("M11a: implement std-only Tiled JSON → ZoneMapDef parser")
}

fn main() {
    // Thin wrapper: arg parsing + file I/O + parse_tiled_json + RON output.
    // No logic lives here (no-logic-in-wrapper eval, ADR-0051).
    eprintln!("tiled_import: not yet implemented (M11a stub)");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Fixture builder: minimal Tiled JSON with a single tile layer.
    // GID list length must equal width * height for a valid map.
    // -----------------------------------------------------------------------

    fn minimal_tiled_json(width: usize, height: usize, gids: &[u32]) -> String {
        let data = gids
            .iter()
            .map(|g| g.to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"width":{width},"height":{height},"layers":[{{"type":"tilelayer","name":"Tiles","data":[{data}]}}]}}"#
        )
    }

    // -----------------------------------------------------------------------
    // M11a EARS criterion: GID mapping to string-art rows
    // -----------------------------------------------------------------------

    /// Criterion: a 3×2 map of all floor tiles (GID 1) produces two "..." rows.
    ///
    /// Kills: an impl that mis-maps GID 1, or produces rows in wrong order,
    /// or sets zone_id to the wrong value.
    #[test]
    fn parse_tiled_minimal_tile_layer() {
        let json = minimal_tiled_json(3, 2, &[1, 1, 1, 1, 1, 1]);
        let result = parse_tiled_json(&json, 0).expect("minimal tile layer must parse");
        assert_eq!(result.zone_id, 0, "zone_id must match the argument");
        assert_eq!(result.rows.len(), 2, "height=2 must produce 2 rows");
        assert_eq!(result.rows[0], "...", "row 0 must be all floor '.'");
        assert_eq!(result.rows[1], "...", "row 1 must be all floor '.'");
    }

    /// Criterion: GID 0 maps to wall '#', GID 1 maps to floor '.'.
    ///
    /// Kills: an impl that swaps wall/floor GIDs, or that uses GID 0 as floor.
    /// A tile placed at wall position would allow walking through walls.
    #[test]
    fn parse_tiled_gid_0_is_wall() {
        let json = minimal_tiled_json(2, 1, &[0, 1]);
        let result = parse_tiled_json(&json, 5).expect("parse must succeed");
        assert_eq!(result.zone_id, 5, "zone_id must be passed through");
        assert_eq!(result.rows.len(), 1, "height=1 must produce 1 row");
        assert_eq!(
            result.rows[0], "#.",
            "GID 0 must be wall '#', GID 1 must be floor '.'"
        );
    }

    /// Criterion: GID 2 maps to tall-grass '~'.
    ///
    /// Kills: an impl that treats GID 2 as an unknown GID (returning Err) or
    /// maps it to '.' (losing encounter trigger information).
    #[test]
    fn parse_tiled_gid_2_is_grass() {
        let json = minimal_tiled_json(3, 1, &[1, 2, 1]);
        let result = parse_tiled_json(&json, 0).expect("parse must succeed");
        assert_eq!(result.rows[0], ".~.", "GID 2 must map to tall-grass '~'");
    }

    // -----------------------------------------------------------------------
    // M11a EARS criterion: warp object layer parsing
    // -----------------------------------------------------------------------

    /// Criterion: a "Warps" object layer produces a correctly-populated WarpDef.
    ///
    /// Kills: an impl that ignores the "Warps" object layer entirely, or that
    /// parses x/y incorrectly (e.g. swaps to_x/to_y, or forgets to_zone).
    #[test]
    fn parse_tiled_reads_warp_object() {
        let json = r#"{
          "width": 3, "height": 3,
          "layers": [
            {"type": "tilelayer", "name": "Tiles", "data": [1,1,1,1,1,1,1,1,1]},
            {"type": "objectgroup", "name": "Warps", "objects": [
              {"x": 1, "y": 2, "properties": [
                {"name": "to_zone", "value": 7},
                {"name": "to_x", "value": 4},
                {"name": "to_y", "value": 5}
              ]}
            ]}
          ]
        }"#;
        let result = parse_tiled_json(json, 0).expect("warp object must parse");
        assert_eq!(result.warps.len(), 1, "must produce exactly one WarpDef");
        let warp = &result.warps[0];
        assert_eq!(
            warp.from,
            TilePos { x: 1, y: 2 },
            "WarpDef.from must match the object's x/y"
        );
        assert_eq!(
            warp.to_zone, 7,
            "WarpDef.to_zone must match to_zone property"
        );
        assert_eq!(
            warp.to_tile,
            TilePos { x: 4, y: 5 },
            "WarpDef.to_tile must match to_x/to_y properties"
        );
    }

    // -----------------------------------------------------------------------
    // M11a EARS criterion: fail-loud rejection cases
    // -----------------------------------------------------------------------

    /// Criterion: data.len() != width * height must be rejected.
    ///
    /// Kills: an impl that truncates or zero-pads the data array silently,
    /// which would produce a map with wrong geometry.
    #[test]
    fn parse_tiled_rejects_ragged_data() {
        // 3×2 = 6 tiles expected, but only 3 provided
        let json = minimal_tiled_json(3, 2, &[1, 1, 1]);
        assert!(
            parse_tiled_json(&json, 0).is_err(),
            "data.len()=3 != width*height=6 must be rejected"
        );
    }

    /// Criterion: an unknown GID (not in {0, 1, 2}) must be rejected.
    ///
    /// Kills: an impl that silently maps unknown GIDs to a default tile,
    /// which would hide content errors.
    #[test]
    fn parse_tiled_rejects_unknown_gid() {
        let json = minimal_tiled_json(2, 1, &[1, 99]); // GID 99 is not in {0,1,2}
        assert!(
            parse_tiled_json(&json, 0).is_err(),
            "unknown GID 99 must be rejected"
        );
    }

    /// Criterion: malformed JSON must be rejected.
    ///
    /// Kills: an impl that panics on bad JSON or silently returns a default.
    #[test]
    fn parse_tiled_rejects_malformed_json() {
        assert!(
            parse_tiled_json("{not valid json", 0).is_err(),
            "malformed JSON must return Err"
        );
    }

    /// Criterion: a JSON with no tile layer must be rejected.
    ///
    /// Kills: an impl that returns an empty-rows ZoneMapDef when no tile layer
    /// is present, rather than failing loud.
    #[test]
    fn parse_tiled_rejects_missing_tile_layer() {
        let json = r#"{"width":2,"height":1,"layers":[]}"#;
        assert!(
            parse_tiled_json(json, 0).is_err(),
            "missing tile layer must be rejected"
        );
    }

    /// Criterion: an empty string must be rejected (degenerate input).
    ///
    /// Kills: an impl whose JSON parser panics on empty input.
    #[test]
    fn parse_tiled_rejects_empty_string() {
        assert!(
            parse_tiled_json("", 0).is_err(),
            "empty JSON string must be rejected"
        );
    }

    /// Criterion: a JSON with layers key but no objects in Warps layer → empty warps vec.
    ///
    /// Kills: an impl that errors on an empty Warps object layer instead of
    /// returning `warps: vec![]`.
    #[test]
    fn parse_tiled_empty_warps_layer_produces_no_warps() {
        let json = r#"{
          "width": 2, "height": 1,
          "layers": [
            {"type": "tilelayer", "name": "Tiles", "data": [1,1]},
            {"type": "objectgroup", "name": "Warps", "objects": []}
          ]
        }"#;
        let result = parse_tiled_json(json, 0).expect("empty Warps layer must not error");
        assert!(
            result.warps.is_empty(),
            "an empty Warps object layer must produce zero WarpDefs"
        );
    }

    /// Criterion: parse_tiled_json output passes validate_zone_maps when combined
    /// with a matching zones registry.
    ///
    /// This is the round-trip gate: Tiled JSON → ZoneMapDef → validate_zone_maps Ok.
    /// Kills: an impl that parses correctly but produces ZoneMapDef rows that
    /// validate_zone_maps rejects (e.g. ragged rows, non-walkable warp sources).
    #[test]
    fn parse_tiled_output_validates() {
        // 3×3 all-floor map — every tile walkable, no warps.
        let json = minimal_tiled_json(3, 3, &[1; 9]);
        let zone_map = parse_tiled_json(&json, 0).expect("3x3 floor map must parse");

        // Build a matching zones registry entry (zone 0, large enough).
        let zones = vec![game_core::content::ZoneDef {
            id: 0,
            name: "TestZone".to_string(),
            width: 10,
            height: 10,
        }];
        let zone_maps = vec![zone_map];

        game_core::world::validate_zone_maps(&zone_maps, &zones)
            .expect("parse_tiled_json output must pass validate_zone_maps");
    }
}
