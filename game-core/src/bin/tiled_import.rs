// tiled_import.rs — M11a: pure Tiled JSON → ZoneMapDef converter.
//
// Architecture: std-only recursive-descent JSON parser. No serde_json —
// game-core Cargo.toml must not gain new deps (constraint from build plan).
// GID convention: 0 = wall('#'), 1 = floor('.'), 2 = grass('~').
// Object layer "Warps": objects with to_zone, to_x, to_y int properties.

use game_core::content::{WarpDef, ZoneMapDef};
use game_core::types::TilePos;

// ===========================================================================
// Minimal JSON value tree — covers the Tiled subset we need.
// ===========================================================================

// JsonValue covers the full JSON grammar so the recursive-descent parser can
// handle any valid JSON. Not all variants are used in the Tiled output path
// (e.g. Bool, Null) — allow dead_code rather than removing them, since
// removing them would make the parser silently fail on JSON with those values.
#[allow(dead_code)]
#[derive(Debug)]
enum JsonValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsonValue>),
    /// Object as ordered key-value pairs (avoids HashMap dep).
    Obj(Vec<(String, JsonValue)>),
}

// ===========================================================================
// Recursive-descent parser
// ===========================================================================

struct Parser<'a> {
    input: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Parser {
            input: input.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<u8> {
        let b = self.input.get(self.pos).copied();
        if b.is_some() {
            self.pos += 1;
        }
        b
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect_byte(&mut self, b: u8) -> Result<(), String> {
        self.skip_whitespace();
        match self.advance() {
            Some(got) if got == b => Ok(()),
            Some(got) => Err(format!(
                "expected '{}' at pos {}, got '{}'",
                b as char,
                self.pos - 1,
                got as char
            )),
            None => Err(format!(
                "expected '{}' at pos {}, got EOF",
                b as char, self.pos
            )),
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'"') => self.parse_string().map(JsonValue::Str),
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b't') => {
                self.expect_literal(b"true")?;
                Ok(JsonValue::Bool(true))
            }
            Some(b'f') => {
                self.expect_literal(b"false")?;
                Ok(JsonValue::Bool(false))
            }
            Some(b'n') => {
                self.expect_literal(b"null")?;
                Ok(JsonValue::Null)
            }
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            Some(c) => Err(format!(
                "unexpected char '{}' at pos {}",
                c as char, self.pos
            )),
            None => Err(format!("unexpected EOF at pos {}", self.pos)),
        }
    }

    fn expect_literal(&mut self, lit: &[u8]) -> Result<(), String> {
        for &b in lit {
            match self.advance() {
                Some(got) if got == b => {}
                Some(got) => {
                    return Err(format!(
                        "expected '{}', got '{}' at pos {}",
                        b as char,
                        got as char,
                        self.pos - 1
                    ))
                }
                None => return Err("unexpected EOF in literal".to_string()),
            }
        }
        Ok(())
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect_byte(b'"')?;
        // Accumulate raw bytes; decode as UTF-8 at the end so multi-byte
        // sequences are handled correctly (avoids Latin-1 mojibake from b as char).
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match self.advance() {
                None => return Err("unterminated string".to_string()),
                Some(b'"') => break,
                Some(b'\\') => {
                    match self.advance() {
                        Some(b'"') => buf.push(b'"'),
                        Some(b'\\') => buf.push(b'\\'),
                        Some(b'/') => buf.push(b'/'),
                        Some(b'n') => buf.push(b'\n'),
                        Some(b't') => buf.push(b'\t'),
                        Some(b'r') => buf.push(b'\r'),
                        Some(b'b') => buf.push(0x08),
                        Some(b'f') => buf.push(0x0C),
                        Some(b'u') => {
                            // Parse 4 hex digits → Unicode scalar → UTF-8
                            let mut hex = [0u8; 4];
                            for h in &mut hex {
                                *h = self.advance().ok_or("EOF in unicode escape")?;
                            }
                            let hex_str =
                                std::str::from_utf8(&hex).map_err(|_| "invalid unicode escape")?;
                            let code = u32::from_str_radix(hex_str, 16)
                                .map_err(|_| format!("invalid hex in \\u{hex_str}"))?;
                            let ch = char::from_u32(code)
                                .ok_or_else(|| format!("invalid unicode codepoint {code}"))?;
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        Some(c) => return Err(format!("unknown escape \\{}", c as char)),
                        None => return Err("EOF after backslash".to_string()),
                    }
                }
                Some(b) => buf.push(b),
            }
        }
        String::from_utf8(buf).map_err(|e| format!("invalid UTF-8 in string: {e}"))
    }

    fn parse_number(&mut self) -> Result<JsonValue, String> {
        let start = self.pos;
        // optional minus
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        // digits
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        // optional fractional
        if self.peek() == Some(b'.') {
            self.pos += 1;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        // optional exponent
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let s = std::str::from_utf8(&self.input[start..self.pos])
            .map_err(|_| "non-UTF8 in number".to_string())?;
        let n: f64 = s.parse().map_err(|e| format!("bad number {s}: {e}"))?;
        Ok(JsonValue::Num(n))
    }

    fn parse_array(&mut self) -> Result<JsonValue, String> {
        self.expect_byte(b'[')?;
        let mut arr = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(JsonValue::Arr(arr));
        }
        loop {
            arr.push(self.parse_value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                other => {
                    return Err(format!(
                        "expected ',' or ']' in array at pos {}, got {:?}",
                        self.pos,
                        other.map(|b| b as char)
                    ))
                }
            }
        }
        Ok(JsonValue::Arr(arr))
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.expect_byte(b'{')?;
        let mut pairs = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(JsonValue::Obj(pairs));
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.expect_byte(b':')?;
            let val = self.parse_value()?;
            pairs.push((key, val));
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                other => {
                    return Err(format!(
                        "expected ',' or '}}' in object at pos {}, got {:?}",
                        self.pos,
                        other.map(|b| b as char)
                    ))
                }
            }
        }
        Ok(JsonValue::Obj(pairs))
    }
}

// ===========================================================================
// JSON value helpers
// ===========================================================================

fn obj_get<'a>(obj: &'a [(String, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn as_u32(v: &JsonValue, ctx: &str) -> Result<u32, String> {
    match v {
        JsonValue::Num(n) => {
            if !n.is_finite() {
                return Err(format!("{ctx}: non-finite number {n}"));
            }
            let i = *n as i64;
            if i as f64 != n.trunc() {
                return Err(format!("{ctx}: {n} is not an integer"));
            }
            u32::try_from(i).map_err(|_| format!("{ctx}: value {n} out of u32 range"))
        }
        other => Err(format!("{ctx}: expected number, got {other:?}")),
    }
}

fn as_i32(v: &JsonValue, ctx: &str) -> Result<i32, String> {
    match v {
        JsonValue::Num(n) => {
            if !n.is_finite() {
                return Err(format!("{ctx}: non-finite number {n}"));
            }
            let i = *n as i64;
            if i as f64 != n.trunc() {
                return Err(format!("{ctx}: {n} is not an integer"));
            }
            i32::try_from(i).map_err(|_| format!("{ctx}: value {n} out of i32 range"))
        }
        other => Err(format!("{ctx}: expected number, got {other:?}")),
    }
}

fn as_str<'a>(v: &'a JsonValue, ctx: &str) -> Result<&'a str, String> {
    match v {
        JsonValue::Str(s) => Ok(s.as_str()),
        other => Err(format!("{ctx}: expected string, got {other:?}")),
    }
}

fn as_arr<'a>(v: &'a JsonValue, ctx: &str) -> Result<&'a [JsonValue], String> {
    match v {
        JsonValue::Arr(a) => Ok(a.as_slice()),
        other => Err(format!("{ctx}: expected array, got {other:?}")),
    }
}

fn as_obj<'a>(v: &'a JsonValue, ctx: &str) -> Result<&'a [(String, JsonValue)], String> {
    match v {
        JsonValue::Obj(pairs) => Ok(pairs.as_slice()),
        other => Err(format!("{ctx}: expected object, got {other:?}")),
    }
}

// ===========================================================================
// parse_tiled_json — the public entry point
// ===========================================================================

/// Parse a Tiled JSON export (minimal subset) into a `ZoneMapDef`.
///
/// # Errors
/// Returns `Err` if:
/// - `json` is not valid JSON in the expected subset
/// - There is no `tilelayer` (any name)
/// - `data.len() != width * height`
/// - Any GID is not in {0, 1, 2}
/// - A "Warps" object layer has a malformed object or missing properties
pub fn parse_tiled_json(json: &str, zone_id: u32) -> Result<ZoneMapDef, String> {
    if json.is_empty() {
        return Err("empty JSON input".to_string());
    }

    // Parse JSON
    let mut parser = Parser::new(json);
    let root_val = parser
        .parse_value()
        .map_err(|e| format!("JSON parse error: {e}"))?;
    parser.skip_whitespace();
    if parser.pos < parser.input.len() {
        return Err(format!("trailing content after JSON at pos {}", parser.pos));
    }

    let root = as_obj(&root_val, "root")?;

    // Extract width and height
    let width_val = obj_get(root, "width").ok_or("missing 'width' in root object")?;
    let width = as_u32(width_val, "width")? as usize;

    let height_val = obj_get(root, "height").ok_or("missing 'height' in root object")?;
    let height = as_u32(height_val, "height")? as usize;

    // Extract layers
    let layers_val = obj_get(root, "layers").ok_or("missing 'layers' in root object")?;
    let layers = as_arr(layers_val, "layers")?;

    // Find the tile layer (any tilelayer)
    let mut tile_data: Option<&[JsonValue]> = None;
    let mut warps: Vec<WarpDef> = Vec::new();

    for (i, layer_val) in layers.iter().enumerate() {
        let layer = as_obj(layer_val, &format!("layers[{i}]"))?;

        let layer_type_val =
            obj_get(layer, "type").ok_or_else(|| format!("layers[{i}]: missing 'type'"))?;
        let layer_type = as_str(layer_type_val, &format!("layers[{i}].type"))?;

        if layer_type == "tilelayer" && tile_data.is_none() {
            let data_val = obj_get(layer, "data")
                .ok_or_else(|| format!("layers[{i}] (tilelayer): missing 'data'"))?;
            let data_arr = as_arr(data_val, &format!("layers[{i}].data"))?;
            tile_data = Some(data_arr);
        } else if layer_type == "objectgroup" {
            // Check if this is the "Warps" layer
            let name_val = obj_get(layer, "name");
            let is_warps = matches!(name_val, Some(JsonValue::Str(s)) if s == "Warps");

            if is_warps {
                let objects_val = obj_get(layer, "objects")
                    .ok_or_else(|| format!("layers[{i}] (Warps): missing 'objects'"))?;
                let objects = as_arr(objects_val, &format!("layers[{i}].objects"))?;

                for (j, obj_val) in objects.iter().enumerate() {
                    let obj = as_obj(obj_val, &format!("layers[{i}].objects[{j}]"))?;

                    let from_x_val = obj_get(obj, "x")
                        .ok_or_else(|| format!("Warps object[{j}]: missing 'x'"))?;
                    let from_x = as_i32(from_x_val, &format!("Warps object[{j}].x"))?;

                    let from_y_val = obj_get(obj, "y")
                        .ok_or_else(|| format!("Warps object[{j}]: missing 'y'"))?;
                    let from_y = as_i32(from_y_val, &format!("Warps object[{j}].y"))?;

                    // Parse custom properties
                    let props_val = obj_get(obj, "properties")
                        .ok_or_else(|| format!("Warps object[{j}]: missing 'properties'"))?;
                    let props = as_arr(props_val, &format!("Warps object[{j}].properties"))?;

                    let mut to_zone: Option<u32> = None;
                    let mut to_x: Option<i32> = None;
                    let mut to_y: Option<i32> = None;

                    for (k, prop_val) in props.iter().enumerate() {
                        let prop = as_obj(prop_val, &format!("properties[{k}]"))?;
                        let name_v = obj_get(prop, "name")
                            .ok_or_else(|| format!("properties[{k}]: missing 'name'"))?;
                        let name = as_str(name_v, &format!("properties[{k}].name"))?;
                        let value_v = obj_get(prop, "value")
                            .ok_or_else(|| format!("properties[{k}]: missing 'value'"))?;
                        match name {
                            "to_zone" => {
                                to_zone = Some(as_u32(value_v, "to_zone")?);
                            }
                            "to_x" => {
                                to_x = Some(as_i32(value_v, "to_x")?);
                            }
                            "to_y" => {
                                to_y = Some(as_i32(value_v, "to_y")?);
                            }
                            _ => {} // ignore unknown properties
                        }
                    }

                    let to_zone = to_zone
                        .ok_or_else(|| format!("Warps object[{j}]: missing 'to_zone' property"))?;
                    let to_x =
                        to_x.ok_or_else(|| format!("Warps object[{j}]: missing 'to_x' property"))?;
                    let to_y =
                        to_y.ok_or_else(|| format!("Warps object[{j}]: missing 'to_y' property"))?;

                    warps.push(WarpDef {
                        from: TilePos {
                            x: from_x,
                            y: from_y,
                        },
                        to_zone,
                        to_tile: TilePos { x: to_x, y: to_y },
                    });
                }
            }
        }
    }

    // Fail if no tile layer found
    let tile_data = tile_data.ok_or("no tilelayer found in layers")?;

    // Validate data length
    let expected = width
        .checked_mul(height)
        .ok_or_else(|| format!("map dimensions {width}×{height} overflow usize"))?;
    if tile_data.len() != expected {
        return Err(format!(
            "data.len()={} != width*height={width}*{height}={}",
            tile_data.len(),
            expected
        ));
    }

    // Build rows from GIDs
    let mut rows: Vec<String> = Vec::with_capacity(height);
    for row_idx in 0..height {
        let mut row = String::with_capacity(width);
        for col_idx in 0..width {
            let gid_val = &tile_data[row_idx * width + col_idx];
            let gid = as_u32(gid_val, &format!("data[{}]", row_idx * width + col_idx))?;
            let ch = match gid {
                0 => '#',
                1 => '.',
                2 => '~',
                other => {
                    return Err(format!(
                        "unknown GID {other} at row={row_idx} col={col_idx} (expected 0, 1, or 2)"
                    ))
                }
            };
            row.push(ch);
        }
        rows.push(row);
    }

    Ok(ZoneMapDef {
        zone_id,
        rows,
        warps,
    })
}

fn main() {
    // Thin wrapper: arg parsing + file I/O + parse_tiled_json + RON output.
    // No logic lives here (no-logic-in-wrapper eval, ADR-0051).
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: tiled_import <input.json> <zone_id>");
        std::process::exit(1);
    }
    let path = &args[1];
    let zone_id: u32 = match args[2].parse() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("tiled_import: invalid zone_id '{}': {e}", args[2]);
            std::process::exit(1);
        }
    };
    let json = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tiled_import: cannot read '{path}': {e}");
            std::process::exit(1);
        }
    };
    match parse_tiled_json(&json, zone_id) {
        Ok(zone_map) => match ron::to_string(&zone_map) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("tiled_import: RON serialization error: {e}");
                std::process::exit(1);
            }
        },
        Err(e) => {
            eprintln!("tiled_import: parse error: {e}");
            std::process::exit(1);
        }
    }
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
