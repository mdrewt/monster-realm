//! RED-PHASE STUB (sr-9b): consts per the contract, generators empty, hooks unwired.
use crate::types::TilePos;
pub const LOAD_ZONE_FIRST_ID: u32 = 10_000;
pub const LOAD_ZONE_COUNT: u32 = 100;
pub const LOAD_ZONE_IDS: core::ops::Range<u32> =
    LOAD_ZONE_FIRST_ID..LOAD_ZONE_FIRST_ID + LOAD_ZONE_COUNT;
pub const LOAD_ZONE_SIDE: u32 = 16;
pub const LOAD_ZONE_SPAWN: TilePos = TilePos { x: 1, y: 1 };
#[cfg(feature = "load_test_zones")]
pub fn generated_zones() -> Vec<crate::content::ZoneDef> {
    Vec::new()
}
#[cfg(feature = "load_test_zones")]
pub fn generated_zone_maps() -> Vec<crate::content::ZoneMapDef> {
    Vec::new()
}
#[cfg(feature = "load_test_zones")]
pub fn generated_tactics_zones(
    _authored: &[crate::tactics::TacticsZoneDef],
) -> Vec<crate::tactics::TacticsZoneDef> {
    Vec::new()
}
#[cfg(test)]
#[path = "load_test_zones_tests.rs"]
mod tests;
