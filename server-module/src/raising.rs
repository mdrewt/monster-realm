//! `raising` — server-module domain submodule (M8.9, ADR-0056 / ADR-0059).
//!
//! The M9b raising shell: the `care` reducer (itemless bond raise, server-
//! authoritative per-monster cooldown). It is THIN — find the monster, check
//! ownership, run the pure decision seam `evaluate_care` (which delegates the bond
//! arithmetic to the SSOT `game_core::apply_care` and then gates on the cooldown),
//! and only on `Ok` mutate + dual-write `monster` / `monster_pub`. No DB write
//! occurs before the success path, so a rejected `care` can never burn the
//! cooldown or mutate bond (the reducer transaction rolls back on any `Err`).
//!
//! `train` (focus-training food spend) is parked as M9b-tail — it forces edits
//! outside this slice's server touch-set (game-core content + a public `ItemRow`
//! column). See ADR-0059 §4.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::require_owner;
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{monster, monster_pub};
use game_core::{apply_care, Bond};
use spacetimedb::ReducerContext;

/// Fixed bond raise per successful `care` (tunable policy the reducer supplies to
/// the pure rule; ADR-0058 §residual(c) / ADR-0059 §3). Initial tuning is a
/// playtest call (spec §6 "bond curve … tunable"), not a contract.
pub(crate) const CARE_BOND_AMOUNT: u8 = 5;
/// Per-monster care cooldown (6h). Documented as playtest-tunable (spec §6).
pub(crate) const CARE_COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;

/// Pure decision seam (testable without a DB): apply the SSOT bond rule FIRST
/// (so `AtMaxBond` / `NoEffect` reject before the cooldown is consulted — the
/// order matches ADR-0058 §3 / ADR-0059 §3), THEN gate on the cooldown. Returns
/// the new bond value, or `Err` if the action is rejected.
///
/// The cooldown comparison is strict `<` (elapsed == `CARE_COOLDOWN_MS` is
/// ALLOWED), and the elapsed is `now_ms.saturating_sub(last_care_at_ms)` so a
/// future/zero clock can only OVER-reject, never wrap into a bypass.
pub(crate) fn evaluate_care(bond: u8, last_care_at_ms: i64, now_ms: i64) -> Result<u8, String> {
    let new_bond = apply_care(Bond::new(bond), CARE_BOND_AMOUNT).map_err(|e| format!("{e:?}"))?;
    if now_ms.saturating_sub(last_care_at_ms) < CARE_COOLDOWN_MS {
        return Err("care cooldown not yet elapsed".to_string());
    }
    Ok(new_bond.value())
}

/// Raise a monster's bond, gated by a per-monster cooldown measured from the
/// server clock (`ctx.timestamp`, never a client argument). Ownership-checked;
/// dual-writes the private `monster` row and its public `monster_pub` projection.
/// No DB write before the success path — a reject (not found, not owner, max bond,
/// within cooldown) never burns the cooldown (ADR-0059 §3, reject-never-burns).
#[spacetimedb::reducer]
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    require_owner(ctx, "care", m.owner_identity)?;
    let now = now_ms(ctx);
    let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)?;
    m.bond = new_bond;
    m.last_care_at_ms = now;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

// The gating test `near_max_bond_saturates_to_255` asserts `new_bond <= 255`
// (a u8 is always <= 255 — a deliberate "never exceeds max" guard). That trips
// `absurd_extreme_comparisons` / `unused_comparisons` under `-D warnings`; allow
// them on the test mod (same pattern as game-core's `derive_stats_at_level_100`)
// rather than editing the gating file, which is frozen.
#[cfg(test)]
#[allow(clippy::absurd_extreme_comparisons, unused_comparisons)]
#[path = "raising_tests.rs"]
mod raising_tests;
