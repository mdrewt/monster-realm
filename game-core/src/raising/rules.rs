//! Raising rule functions — focus-training (EV top-off → re-derive), the
//! shared cooldown-ready predicate, and the trade-time trainer-bond reset.
//! All pure and deterministic: no clock, no RNG, no I/O. The care cooldown
//! time is read from `ctx.timestamp`, never here.
//!
//! `focus_train` is **reject-not-clamp**: a maxed target stat / exhausted EV
//! budget returns `Err` so the M9b reducer rejects the action and does NOT
//! consume the food for nothing.
//! Stat derivation is **not** duplicated here — the topped-off EVs are fed back
//! through the single-source `derive_stats`.

use crate::monster::rules::derive_stats;
use crate::monster::types::{
    EVs, IVs, Level, Nature, StatBlock, StatKind, EV_PER_STAT_CAP, EV_TOTAL_CAP,
};

use super::types::{FocusTrainError, FocusTrainResult};

// The per-stat (252) and total (510) EV caps are imported from `monster::types`
// — one SSOT for the caps the `EVs` constructor enforces.
// They are NOT re-declared here; a single definition keeps
// `focus_train`'s top-off in lockstep with `EVs::new`'s rejection thresholds, so
// neither a too-high nor a too-low local copy can drift them apart.

/// Apply a focus-training food: grant `amount` EVs toward `target`, **topped off**
/// to the per-stat cap (252) AND the total-EV cap (510) — never overflowing —
/// then re-derive the monster's stats through the single-source `derive_stats`.
///
/// Returns the new `EVs` and re-derived `StatBlock`.
/// Reject-not-clamp, with precise variants in a pinned guard order:
/// `NoEffect` if `amount == 0`; else `StatAtCap` if the target is already 252;
/// else `BudgetExhausted` if the total is already 510 (target below 252). After
/// the guards the grant is always `>= 1`, so a successful `Ok` always moves at
/// least one EV (reject-not-no-op).
///
/// # Errors
/// `FocusTrainError` whenever the application would move zero EVs (see above).
/// (The returned `Result` — and `FocusTrainResult` — are both `#[must_use]`, so
/// silently drop the re-derived stats.)
pub fn focus_train(
    base: &StatBlock,
    ivs: &IVs,
    evs: &EVs,
    nature: &Nature,
    level: Level,
    target: StatKind,
    amount: u16,
) -> Result<FocusTrainResult, FocusTrainError> {
    if amount == 0 {
        return Err(FocusTrainError::NoEffect);
    }
    let cur = evs.get(target);
    if cur == EV_PER_STAT_CAP {
        return Err(FocusTrainError::StatAtCap);
    }
    let total = evs.total();
    if total == EV_TOTAL_CAP {
        return Err(FocusTrainError::BudgetExhausted);
    }

    // Top-off bounded by BOTH caps. The subtractions are safe — the guards above
    // ensure `cur < 252` and `total < 510`, so each headroom term is `>= 1` and
    // `grant = min(amount>=1, >=1, >=1) >= 1`.
    let grant = amount.min(EV_PER_STAT_CAP - cur).min(EV_TOTAL_CAP - total);

    // `cur + grant <= 252` and `total + grant <= 510` by construction, so the
    // validating constructor cannot reject — the `expect` is genuinely unreachable.
    let new_evs =
        evs_with(evs, target, cur + grant).expect("top-off stays within EV caps by construction");
    let derived_stats = derive_stats(base, ivs, &new_evs, nature, level);

    Ok(FocusTrainResult {
        evs: new_evs,
        derived_stats,
    })
}

/// Per-monster care cooldown in ms (6 h). Playtest-tunable.
pub const CARE_COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;

/// True iff a cooldown has fully elapsed: `now_ms - last_ms >= cooldown_ms`
/// (mirroring `is_challenge_stale`). ONE cooldown-ready predicate shared
/// by the `care` and `heal` shells (both previously open-coded the identical
/// check) — the SSOT for "is this timed action off cooldown yet".
///
/// The elapsed is `now_ms.saturating_sub(last_ms)`, so a future/skewed clock
/// (`last_ms > now_ms`) saturates to `0` and can only OVER-reject (return not-ready),
/// never wrap negative into a bypass — the safe direction. Boundary is `>=`: at
/// exactly `cooldown_ms` elapsed the action IS ready (the exact dual of the shells'
/// prior strict-`<` reject, so behavior is preserved). `cooldown_ms` is a parameter
/// (not a captured const) so per-location heal cooldowns reuse the same predicate.
#[must_use]
pub fn is_cooldown_ready(last_ms: i64, now_ms: i64, cooldown_ms: i64) -> bool {
    now_ms.saturating_sub(last_ms) >= cooldown_ms
}

/// The seven per-trainer bond columns of a monster row — the Trust counters and
/// the Quality-Time accumulators — carried as one value so the trade-time reset
/// rule below can own them. Field names mirror the server's `monster` columns
/// one-to-one (`server-module/src/schema.rs`). The four bookkeeping fields
/// (`trust_favorable_battle_day_epoch` and the three `quality_time_*` ms/window
/// fields) have no `MonsterInstance` counterpart, which is why this is its own
/// value rather than a slice of the instance. Never stored and never on the
/// wire: no `serde` / `SpacetimeType` derive, and no wasm export — the rule is
/// server-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrainerBond {
    pub trust_favorable_count: u32,
    pub trust_unfavorable_count: u32,
    pub trust_favorable_battle_day_epoch: u32,
    pub quality_time_ticks_total: u32,
    pub quality_time_accum_ms: u32,
    pub quality_time_window_ms: u32,
    pub quality_time_window_start_ms: i64,
}

/// Trade-time bond reset (decision "Trading resets the bond, not the monster",
/// answered in <https://github.com/mdrewt/monster-realm/issues/479>): every one
/// of the seven bond fields returns to the fresh-monster baseline `0`. Trust and
/// Quality-Time measure the relationship with the CURRENT trainer, so a new
/// owner starts from zero; the monster's own attributes — level, species, IVs,
/// EVs, nature, xp and the essence pools — are not this rule's concern and are
/// untouched by design.
///
/// `0` is the documented fresh-monster state for all seven: a `0` window anchor
/// makes the new owner's first Quality-Time credit call land in the idle
/// re-anchor branch (no time run under the old trainer is credited), and a `0`
/// day epoch leaves the once-per-day favorable-battle credit available.
///
/// Takes the bond `&mut` (rather than returning a fresh value) so the zero-miss
/// mutation gate can kill a no-op body.
pub fn reset_bond_on_trade(_bond: &mut TrainerBond) {
    // RED scaffold: intentionally a no-op until the gating tests are watched failing.
}

/// Rebuild an `EVs` with `target` set to `new_val` and every other stat copied
/// unchanged from `evs`. Reading each `StatKind` through one closure makes a
/// field-swap / double-write bug impossible (no sibling stat can be silently
/// corrupted). Returns `Err` only if `new_val` would violate a cap — which the
/// `focus_train` top-off guarantees it does not.
fn evs_with(evs: &EVs, target: StatKind, new_val: u16) -> Result<EVs, String> {
    let v = |k: StatKind| if k == target { new_val } else { evs.get(k) };
    EVs::new(
        v(StatKind::Hp),
        v(StatKind::Attack),
        v(StatKind::Defense),
        v(StatKind::Speed),
        v(StatKind::SpAttack),
        v(StatKind::SpDefense),
    )
}
