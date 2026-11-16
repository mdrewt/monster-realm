//! The load-test zones: 100 generated 16×16 zones, ids 10000–10099, that exist only in a build with
//! the `load_test_zones` feature (`just load-host`). Each is all floor: no wall, no grass, no warp
//! and no NPC, with its spawn on [`LOAD_ZONE_SPAWN`]. They are data, built here and appended to the
//! zone, zone-map and tactics-zone registries by the loaders, so a load build runs the same rules
//! over more zones and no rule knows about them.
//!
//! The default build compiles none of this module's functions: only its constants and the three
//! hook macros, whose feature-off arm expands to the loader's own expression unchanged. A function
//! compiled into the default game-core build changes the release module wasm even when nothing
//! calls it, and the default release wasm must stay byte-identical to a build without this module.

use crate::types::TilePos;

/// The first load-test zone id.
pub const LOAD_ZONE_FIRST_ID: u32 = 10_000;

/// How many load-test zones a load build holds.
pub const LOAD_ZONE_COUNT: u32 = 100;

/// Every load-test zone id, `10000..10100`.
pub const LOAD_ZONE_IDS: core::ops::Range<u32> =
    LOAD_ZONE_FIRST_ID..LOAD_ZONE_FIRST_ID + LOAD_ZONE_COUNT;

/// The width and height of every load-test zone, in tiles.
pub const LOAD_ZONE_SIDE: u32 = 16;

/// The tile a character is placed on in every load-test zone.
pub const LOAD_ZONE_SPAWN: TilePos = TilePos { x: 1, y: 1 };

/// One `ZoneDef` per load-test zone, in id order.
#[cfg(feature = "load_test_zones")]
#[must_use]
pub fn generated_zones() -> Vec<crate::content::ZoneDef> {
    LOAD_ZONE_IDS
        .map(|id| crate::content::ZoneDef {
            id,
            name: format!("Load Zone {id}"),
            width: LOAD_ZONE_SIDE,
            height: LOAD_ZONE_SIDE,
        })
        .collect()
}

/// One all-floor map per load-test zone, in id order, with no warp.
#[cfg(feature = "load_test_zones")]
#[must_use]
pub fn generated_zone_maps() -> Vec<crate::content::ZoneMapDef> {
    let row = ".".repeat(LOAD_ZONE_SIDE as usize);
    LOAD_ZONE_IDS
        .map(|zone_id| crate::content::ZoneMapDef {
            zone_id,
            rows: vec![row.clone(); LOAD_ZONE_SIDE as usize],
            warps: Vec::new(),
        })
        .collect()
}

/// One tactics row per load-test zone, in id order: zone 0's authored row with its `zone_id`
/// replaced, so every load zone has the pack weights and battle-map pool content already
/// validates. Empty when `authored` has no zone 0 row, which the tactics content gate then refuses.
#[cfg(feature = "load_test_zones")]
#[must_use]
pub fn generated_tactics_zones(
    authored: &[crate::tactics::TacticsZoneDef],
) -> Vec<crate::tactics::TacticsZoneDef> {
    let Some(template) = authored.iter().find(|row| row.zone_id == 0) else {
        return Vec::new();
    };
    LOAD_ZONE_IDS
        .map(|zone_id| {
            let mut row = template.clone();
            row.zone_id = zone_id;
            row
        })
        .collect()
}

// The loader hooks. Each loader wraps its one parse expression in one of these on the same line,
// so no line of a loader's file moves. With the feature the generated rows are appended to the
// parsed ones; without it the expression is returned untouched.

#[cfg(feature = "load_test_zones")]
macro_rules! zones {
    ($registry:expr) => {
        $registry.map(|mut zones| {
            zones.extend($crate::load_test_zones::generated_zones());
            zones
        })
    };
}

#[cfg(not(feature = "load_test_zones"))]
macro_rules! zones {
    ($registry:expr) => {
        $registry
    };
}

#[cfg(feature = "load_test_zones")]
macro_rules! zone_maps {
    ($registry:expr) => {
        $registry.map(|mut maps| {
            maps.extend($crate::load_test_zones::generated_zone_maps());
            maps
        })
    };
}

#[cfg(not(feature = "load_test_zones"))]
macro_rules! zone_maps {
    ($registry:expr) => {
        $registry
    };
}

#[cfg(feature = "load_test_zones")]
macro_rules! tactics_zones {
    ($registry:expr) => {
        $registry.map(|mut rows| {
            let generated = $crate::load_test_zones::generated_tactics_zones(&rows);
            rows.extend(generated);
            rows
        })
    };
}

#[cfg(not(feature = "load_test_zones"))]
macro_rules! tactics_zones {
    ($registry:expr) => {
        $registry
    };
}

pub(crate) use {tactics_zones, zone_maps, zones};

#[cfg(test)]
#[path = "load_test_zones_tests.rs"]
mod tests;
