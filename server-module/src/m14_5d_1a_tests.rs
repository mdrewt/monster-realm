//! m14.5d-1a gating tests — source-guard suite for the `cure_status` column on
//! `item_row` (EA-1 through EA-3, EA-5).
//!
//! EARS criteria covered:
//!   EA-1  StatusKind in game-core/src/combat/ability.rs has the
//!         `#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]`
//!         attribute.  RED: attribute absent today.
//!   EA-2  ItemRow in server-module/src/schema.rs has a `cure_status` field typed
//!         `Option<StatusKind>` as its last field.  RED: field absent today.
//!   EA-3  `sync_content_inner` in server-module/src/content.rs assigns
//!         `cure_status` from `item.cure_status`.  RED: absent today.
//!   EA-5  evals/baselines/table-schemas.json item_row entry contains a
//!         `cure_status` key.  RED: key absent today.
//!
//! Source-guard pattern: read the file as &str via include_str!, strip comments,
//! search for a needle assembled at runtime via concat!() so the needle string
//! does not appear verbatim in this test source (prevents false-green if these
//! tests are ever included in a self-referencing source scan).

// ---------------------------------------------------------------------------
// Source constants
// ---------------------------------------------------------------------------

/// The production ability.rs source (game-core) — EA-1.
const ABILITY_RS: &str = include_str!("../../game-core/src/combat/ability.rs");

/// The production schema.rs source (server-module) — EA-2.
const SCHEMA_RS: &str = include_str!("schema.rs");

/// The production content.rs source (server-module) — EA-3.
const CONTENT_RS: &str = include_str!("content.rs");

/// The eval baseline JSON — EA-5.
const TABLE_SCHEMAS_JSON: &str = include_str!("../../evals/baselines/table-schemas.json");

// ---------------------------------------------------------------------------
// Helper: strip Rust block comments and line comments
// (mirrors the helper in battle_tests.rs / content.rs test block)
// ---------------------------------------------------------------------------

fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            // Block comment: blank until `*/`.
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            // Line comment: blank to end of line.
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

// ---------------------------------------------------------------------------
// EA-1: StatusKind derives SpacetimeType via cfg_attr
//
// RED state today: `StatusKind` in ability.rs only has
//   #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
// The cfg_attr for SpacetimeType is absent.
//
// What a wrong impl this kills: any impl that derives SpacetimeType
// unconditionally (wrong — breaks non-spacetimedb builds) or omits the
// derive entirely (wrong — BSATN cannot encode StatusKind in item_row).
// ---------------------------------------------------------------------------

#[test]
fn ears_d1a_1_status_kind_derives_spacetime_type() {
    let stripped = strip_rust_comments(ABILITY_RS);

    // Build the needle at runtime to prevent self-match.
    // Target: `#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]`
    // Split across two concat segments so neither half is the full attribute text.
    let needle = [
        r#"cfg_attr(feature = "spacetimedb""#,
        r#", derive(spacetimedb::SpacetimeType))"#,
    ]
    .concat();

    // We also want to verify the attribute appears near `StatusKind`, not just
    // anywhere in the file.  Find the enum declaration and check the attribute
    // is in the ~300 bytes before it.
    let enum_needle = ["enum ", "StatusKind"].concat();
    let enum_pos = stripped
        .find(enum_needle.as_str())
        .expect("StatusKind enum must be declared in ability.rs");

    let window_start = enum_pos.saturating_sub(400);
    let preceding = &stripped[window_start..enum_pos];

    assert!(
        preceding.contains(needle.as_str()),
        "TEETH(EA-1 m14.5d-1a): `StatusKind` in game-core/src/combat/ability.rs must have \
         `#[cfg_attr(feature = \"spacetimedb\", derive(spacetimedb::SpacetimeType))]` \
         in the ~400 bytes before the enum declaration. \
         Currently the attribute is absent — SpacetimeDB cannot BSATN-encode \
         `StatusKind` values stored in the `item_row.cure_status` column. \
         Kills: an impl that adds the column without the derive (BSATN panic at publish)."
    );
}

// ---------------------------------------------------------------------------
// EA-2: ItemRow has a `cure_status: Option<StatusKind>` field
//
// RED state today: ItemRow (schema.rs) ends at `sell_price: u64` and has no
// `cure_status` field.
//
// What a wrong impl this kills: an impl that names the field differently
// (e.g. `status_cure` or `cures`), uses the wrong type (plain StatusKind
// instead of Option), or omits it entirely.
// ---------------------------------------------------------------------------

#[test]
fn ears_d1a_2_item_row_has_cure_status_field() {
    let stripped = strip_rust_comments(SCHEMA_RS);

    // Needle: the field declaration.  We look for it inside the ItemRow struct
    // body, so first locate the struct, then scan its body.
    let struct_needle = ["struct ", "ItemRow"].concat();
    let struct_pos = stripped
        .find(struct_needle.as_str())
        .expect("ItemRow struct must be declared in schema.rs");

    // Walk to the opening brace of the struct body.
    let after_struct = &stripped[struct_pos..];
    let brace_offset = after_struct
        .find('{')
        .expect("ItemRow struct must have a body");
    let body_start = struct_pos + brace_offset + 1;

    // Walk braces to find the matching closing brace.
    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = stripped[body_start..].chars().collect();
    let mut char_i = 0;
    while char_i < chars.len() && depth > 0 {
        match chars[char_i] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_i].len_utf8();
        char_i += 1;
    }
    let body = &stripped[body_start..body_start + rel];

    // Needle for the field: `cure_status: Option<StatusKind>`.
    // Split so the exact declaration text is not verbatim in this source.
    let cs_name = ["cure", "_status"].concat(); // "cure_status"
    let field_needle = [cs_name.as_str(), ": Option<StatusKind>"].concat();

    assert!(
        body.contains(field_needle.as_str()),
        "TEETH(EA-2 m14.5d-1a): `ItemRow` in server-module/src/schema.rs must have a \
         `cure_status: Option<StatusKind>` field. \
         Currently the field is absent — the `item_row` SpacetimeDB table does not \
         expose cure_status to clients, making status-curing items invisible to \
         client subscriptions. \
         Kills: an impl that uses the wrong type (StatusKind instead of Option) or \
         a different field name."
    );
}

// ---------------------------------------------------------------------------
// EA-3: sync_content_inner seeds `cure_status` from `item.cure_status`
//
// RED state today: the ItemRow construction block in content.rs does not
// include a `cure_status` field — the column would be left at its Default
// (None for all items, even Antidote).
//
// What a wrong impl this kills: an impl that adds the ItemRow field but
// forgets to wire the seeding path (every row would have cure_status=None
// regardless of content, making Antidote silently non-functional).
// ---------------------------------------------------------------------------

#[test]
fn ears_d1a_3_sync_content_seeds_cure_status() {
    let stripped = strip_rust_comments(CONTENT_RS);

    // Locate the `sync_content_inner` function body.
    let fn_needle = ["sync_content_inner", "(ctx"].concat();
    let fn_pos = stripped
        .find(fn_needle.as_str())
        .expect("sync_content_inner must be declared in content.rs");

    let after_fn = &stripped[fn_pos..];
    let brace_offset = after_fn
        .find('{')
        .expect("sync_content_inner must have a body");
    let body_start = fn_pos + brace_offset + 1;

    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = stripped[body_start..].chars().collect();
    let mut char_i = 0;
    while char_i < chars.len() && depth > 0 {
        match chars[char_i] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_i].len_utf8();
        char_i += 1;
    }
    let body = &stripped[body_start..body_start + rel];

    // Needle: `cure_status: item.cure_status` (the field assignment in the
    // ItemRow struct literal inside the for-items loop).
    // Split so the full assignment string is not verbatim in this test source.
    let field_name = ["cure", "_status"].concat(); // "cure_status"
    let assignment_needle = [field_name.as_str(), ": item.", field_name.as_str()].concat();

    assert!(
        body.contains(assignment_needle.as_str()),
        "TEETH(EA-3 m14.5d-1a): `sync_content_inner` in server-module/src/content.rs \
         must assign `cure_status: item.cure_status` in the ItemRow construction block. \
         Currently the assignment is absent — all seeded item_row rows would have \
         cure_status=None even for items like Antidote (id=3) that specify \
         cure_status in the content RON, making Antidote permanently non-functional. \
         Kills: an impl that adds the ItemRow field but omits the seeding assignment."
    );
}

// ---------------------------------------------------------------------------
// EA-5: evals/baselines/table-schemas.json item_row entry has `cure_status`
//
// RED state today: the item_row entry in table-schemas.json ends at
// `"sell_price": "u64"` with no `cure_status` key.
//
// What a wrong impl this kills: an impl that updates the schema without
// updating the eval baseline (or that uses a wrong type string like
// `"Option<StatusEffect>"` instead of `"Option<StatusKind>"`).
// ---------------------------------------------------------------------------

#[test]
fn ears_d1a_5_baseline_has_cure_status_column() {
    // The JSON is searched as a plain string — no JSON parser needed for this
    // structural check.  We look for the `cure_status` key inside the
    // `item_row` object, and verify its value string is `Option<StatusKind>`.

    // Locate the item_row section.
    let item_row_needle = [r#""item"#, r#"_row""#].concat();
    let section_pos = TABLE_SCHEMAS_JSON
        .find(item_row_needle.as_str())
        .expect("table-schemas.json must contain an item_row section");

    // Extract a generous window after the section start — the full item_row
    // object is well under 1 000 bytes.
    let window_end = (section_pos + 1000).min(TABLE_SCHEMAS_JSON.len());
    let section = &TABLE_SCHEMAS_JSON[section_pos..window_end];

    // Needle: the key and its expected type value.
    // Split to avoid verbatim appearance in this source.
    let key_needle = [r#""cure"#, r#"_status""#].concat();
    let value_needle = ["Option<Status", "Kind>"].concat();

    assert!(
        section.contains(key_needle.as_str()),
        "TEETH(EA-5 m14.5d-1a): evals/baselines/table-schemas.json must have a \
         `\"cure_status\"` key in the `item_row` columns object. \
         Currently the key is absent — the schema-snapshot eval would pass even \
         after the column is added to the SpacetimeDB table, hiding bindings drift. \
         Add: `\"cure_status\": \"Option<StatusKind>\"` to the item_row columns."
    );

    assert!(
        section.contains(value_needle.as_str()),
        "TEETH(EA-5 m14.5d-1a): the `cure_status` entry in the item_row baseline \
         must have value `\"Option<StatusKind>\"`. \
         Found the key but the value type string is wrong — kills an impl that uses \
         `\"Option<StatusEffect>\"` or `\"StatusKind\"` (non-optional) as the type."
    );
}
