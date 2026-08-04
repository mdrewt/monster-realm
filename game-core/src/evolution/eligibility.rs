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
//! `unmet_requirement` is its explanatory twin: the SAME gate order, rendered
//! as the player-facing reason. It lives here rather than in the reducer so
//! the rejection message and the client requirements panel (EG4-1, which ports
//! this logic) describe a gate identically — gate-describing logic is rules,
//! not reducer plumbing.
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

/// The level gate: INCLUSIVE `>=` against `path.min_level`.
fn level_gate_met(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    instance.level >= path.min_level
}

/// The essence gate: EVERY entry satisfied (AND), looked up by `Affinity`
/// (never by list position). An empty list imposes no requirement.
fn essence_gate_met(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    path.essence
        .iter()
        .all(|req| instance.essence[req.affinity.index()] >= req.amount)
}

/// The Trust gate: `Ord >=` on the smoothed tier; `None` is permissive.
fn trust_gate_met(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    path.min_trust_tier.is_none_or(|tier| {
        trust_tier_of(
            instance.trust_favorable_count,
            instance.trust_unfavorable_count,
        ) >= tier
    })
}

/// The Quality-Time gate: `>=` on the tick-banded tier; `None` is permissive.
fn quality_time_gate_met(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    path.min_quality_time_tier
        .is_none_or(|tier| quality_time_tier_of(instance.quality_time_ticks_total) >= tier)
}

/// The Nutrition gate: `>=` on the EV-budget percentage; `None` is permissive.
fn nutrition_gate_met(instance: &MonsterInstance, path: &EvolutionPath) -> bool {
    path.min_nutrition_pct
        .is_none_or(|pct| nutrition_pct_of(&instance.evs) >= pct)
}

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
    level_gate_met(instance, path)
        && essence_gate_met(instance, path)
        && trust_gate_met(instance, path)
        && quality_time_gate_met(instance, path)
        && nutrition_gate_met(instance, path)
}

/// Why `instance` does NOT satisfy `path` — `None` exactly when
/// [`path_satisfied`] returns `true`.
///
/// Lives HERE, not in the server reducer (EG1-6's shared-predicate rule): the
/// reducer's "reject naming the specific failing requirement" message (EG2-1)
/// and the EG4 client requirements panel must describe the SAME gate the SAME
/// way, so the description logic is rules-layer state, not reducer state.
///
/// Returns the FIRST unmet gate in the canonical gate order
/// `level -> essence -> trust -> quality time -> nutrition`. The message names
/// the gate (containing the keyword `level` / `essence` plus the offending
/// `Affinity` / `trust` / `quality` / `nutrition`) AND that path's own
/// threshold value — never a hardcoded constant, since two edges out of the
/// same species routinely carry different thresholds.
#[must_use]
pub fn unmet_requirement(instance: &MonsterInstance, path: &EvolutionPath) -> Option<String> {
    if !level_gate_met(instance, path) {
        return Some(format!("requires level {}", path.min_level.as_u8()));
    }
    if !essence_gate_met(instance, path) {
        // Name the FIRST unmet entry — the same list order the gate checks.
        let unmet = path
            .essence
            .iter()
            .find(|req| instance.essence[req.affinity.index()] < req.amount)
            .expect("essence gate reported unmet, so an unmet entry exists");
        return Some(format!(
            "requires {} {:?} essence",
            unmet.amount, unmet.affinity
        ));
    }
    if !trust_gate_met(instance, path) {
        let tier = path
            .min_trust_tier
            .expect("trust gate reported unmet, so a threshold is present");
        return Some(format!("requires trust tier {tier:?}"));
    }
    if !quality_time_gate_met(instance, path) {
        let tier = path
            .min_quality_time_tier
            .expect("quality-time gate reported unmet, so a threshold is present");
        return Some(format!("requires quality time tier {tier}"));
    }
    if !nutrition_gate_met(instance, path) {
        let pct = path
            .min_nutrition_pct
            .expect("nutrition gate reported unmet, so a threshold is present");
        return Some(format!("requires nutrition {pct}%"));
    }
    None
}

/// Indices INTO `paths` of every edge whose `from_species` matches the
/// monster's current species AND whose gates are all satisfied.
///
/// Returns the FULL eligible set — never a first-match winner (EG2-2): a
/// monster simultaneously eligible for two paths yields both indices, which is
/// what the player-choice UX is built on.
#[must_use]
pub fn eligible_evolution_paths(instance: &MonsterInstance, paths: &[EvolutionPath]) -> Vec<usize> {
    paths
        .iter()
        .enumerate()
        .filter(|(_, path)| {
            path.from_species == instance.species_id && path_satisfied(instance, path)
        })
        .map(|(index, _)| index)
        .collect()
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
    /// The five tiers in the same ascending order the bands climb — index N is
    /// the tier reached by clearing exactly N band floors.
    const ASCENDING: [TrustTier; 5] = [
        TrustTier::Hostile,
        TrustTier::Wary,
        TrustTier::Neutral,
        TrustTier::Friendly,
        TrustTier::Devoted,
    ];
    // Widen each operand to u64 BEFORE any addition: fav/unfav at u32::MAX must
    // not overflow (the workspace builds release with overflow checks on).
    let numerator = (u64::from(favorable) + u64::from(TRUST_K)) * 100;
    let denominator = u64::from(favorable) + u64::from(unfavorable) + 2 * u64::from(TRUST_K);
    // The bands ascend, so the cleared set is a prefix and its count IS the
    // tier index (0 = Hostile .. 4 = Devoted). Inclusive `>=`: an exact tie
    // resolves upward.
    let cleared = TRUST_BAND_PCT
        .iter()
        .filter(|&&band_pct| numerator >= u64::from(band_pct) * denominator)
        .count();
    ASCENDING[cleared]
}

/// Quality-Time tier (0..=4) from lifetime ticks, banded by
/// `QUALITY_TIME_TIER_TICKS` with INCLUSIVE lower bounds. Saturates at 4.
#[must_use]
pub fn quality_time_tier_of(ticks: u32) -> u8 {
    // The bands ascend, so the reached set is a prefix and its count is the
    // tier; 4 bands means the count (and so the tier) saturates at 4.
    let reached = QUALITY_TIME_TIER_TICKS
        .iter()
        .filter(|&&band| ticks >= band)
        .count();
    u8::try_from(reached).expect("at most 4 bands exist, which fits a u8")
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
    // Clamp BEFORE scaling so an out-of-budget total reads 100, never above.
    let clamped = u32::from(total.min(EV_TOTAL_CAP));
    let pct = clamped * 100 / u32::from(EV_TOTAL_CAP);
    u8::try_from(pct).expect("min(total, 510) * 100 / 510 is at most 100, which fits a u8")
}
