//! RED-PHASE STUB (sr-9b): the reducer exists and does nothing.
#[cfg(feature = "load_test_zones")]
#[spacetimedb::reducer]
pub fn dev_place_in_load_zone(
    ctx: &spacetimedb::ReducerContext,
    zone_id: u32,
) -> Result<(), String> {
    let _ = (ctx, zone_id);
    Ok(())
}
#[cfg(test)]
#[path = "load_dev_tests.rs"]
mod load_dev_tests;
