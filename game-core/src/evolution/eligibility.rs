//! Evolution eligibility — the pure predicate layer of the essence-graph model
//! (spec EG1-6, ADR-0174).
//!
//! `path_satisfied` is the ONE shared gate predicate: it AND-combines an
//! `EvolutionPath`'s five gates (level, per-`Affinity` essence, Trust,
//! Quality Time, Nutrition) against a `MonsterInstance`. Both the read path
//! (`eligible_evolution_paths`, powering the requirements panel and the
//! multi-choice UX) and the write path (the server `evolve` reducer's single
//! targeted row) call it — one predicate, so they cannot drift.
//!
//! All three derived tiers come from `MonsterInstance` fields, never from a
//! caller-computed argument: `trust_tier_of` (Bayesian-smoothed, `K = 10`),
//! `quality_time_tier_of` (tick bands), `nutrition_pct_of` (the EV pool as a
//! percentage of its 510 budget).
//!
//! Fusion is DELETED, not repurposed (`fusion_eligible`, `FusionError`,
//! `MIN_FUSION_LEVEL`, `MIN_FUSION_BOND`), as are `resolve_evolution` and
//! `evolves_to` — the whole trigger model they served no longer exists.
//!
//! Pure and deterministic (ADR-0003): integer math only, no floats, no clock,
//! no RNG.

use crate::content::{EvolutionPath, TrustTier};
use crate::monster::types::{EVs, MonsterInstance, EV_TOTAL_CAP};

/// Bayesian smoothing constant for Trust (spec EG1-6, ADR-0174 D4).
///
/// `smoothed = (fav + K) / (fav + unfav + 2K)`. FIXED by directive — unlike the
/// band boundaries, this is a structural design choice, not a playtest knob:
/// it is what stops a single favorable event from saturating the ratio to 1.0.
pub const TRUST_K: u32 = 10;

/// Lower bounds (percent, INCLUSIVE) of the four upper Trust bands, ascending:
/// `>= 30%` Wary, `>= 45%` Neutral, `>= 60%` Friendly, `>= 80%` Devoted.
/// Below the first band is `Hostile`. Playtest-tunable (spec §6).
pub const TRUST_BAND_PCT: [u32; 4] = [30, 45, 60, 80];

/// Lower bounds (INCLUSIVE) of Quality-Time tiers 1..=4 in lifetime ticks.
/// Below the first entry is tier 0. Playtest-tunable (spec §6).
pub const QUALITY_TIME_TIER_TICKS: [u32; 4] = [10, 50, 150, 400];

/// Does `instance` satisfy EVERY gate on `path`?
///
/// AND-combination of all five gates. A `None` history gate is PERMISSIVE
/// (absent, not "requires the lowest tier"); an empty `essence` list imposes no
/// essence requirement. Essence is matched by `Affinity`, never by position.
/// Thresholds are INCLUSIVE (`>=`).
///
/// Does NOT check `from_species` — that is `eligible_evolution_paths`' filter
/// and the reducer's indexed lookup.
#[must_use]
pub fn path_satisfied(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    let _ = (instance, path);
    unimplemented!("EG1")
}

/// Indices INTO `paths` of every edge whose `from_species` matches the
/// monster's current species AND whose gates are all satisfied.
///
/// Returns the FULL eligible set — never a first-match winner (EG2-2): a
/// monster simultaneously eligible for two paths yields both indices, which is
/// what the player-choice UX is built on.
#[must_use]
pub fn eligible_evolution_paths(instance: &MonsterInstance, paths: &[EvolutionPath]) -> Vec<usize> {
    let _ = (instance, paths);
    unimplemented!("EG1")
}

/// Trust tier from the lifetime favorable/unfavorable counts, with Drew's
/// Bayesian smoothing applied BEFORE any band lookup (EG1-6):
/// `smoothed = (fav + TRUST_K) / (fav + unfav + 2 * TRUST_K)`.
///
/// Evaluated in integer math by cross-multiplication against `TRUST_BAND_PCT`
/// (no floats in game-core, ADR-0003). Zero history is exactly 50% -> `Neutral`.
/// Must be TOTAL: the widened sum must not overflow for `fav`/`unfav` at
/// `u32::MAX` (the workspace builds release with overflow checks on).
#[must_use]
pub fn trust_tier_of(favorable: u32, unfavorable: u32) -> TrustTier {
    let _ = (favorable, unfavorable);
    unimplemented!("EG1")
}

/// Quality-Time tier (0..=4) from lifetime ticks, banded by
/// `QUALITY_TIME_TIER_TICKS` with INCLUSIVE lower bounds. Saturates at 4.
#[must_use]
pub fn quality_time_tier_of(ticks: u32) -> u8 {
    let _ = ticks;
    unimplemented!("EG1")
}

/// Nutrition as a percentage (0..=100) of the EV budget: the existing EV pool
/// relabeled, no new storage (spec §1). Delegates to
/// [`nutrition_pct_from_ev_total`] so the server's row-based caller and this
/// instance-based one share ONE formula (ADR-0174 D3).
#[must_use]
pub fn nutrition_pct_of(evs: &EVs) -> u8 {
    nutrition_pct_from_ev_total(evs.total())
}

/// Nutrition percentage from a raw EV total. `pub` (not `pub(crate)`) because
/// `server-module`'s marshal layer computes `MonsterPub.nutrition_pct` from a
/// stored total across the crate boundary.
///
/// `0 -> 0`, the full `EV_TOTAL_CAP` (510) -> 100, and the result NEVER exceeds
/// 100 even if a caller passes a total above the budget.
#[must_use]
pub fn nutrition_pct_from_ev_total(total: u16) -> u8 {
    let _ = (total, EV_TOTAL_CAP);
    unimplemented!("EG1")
}
