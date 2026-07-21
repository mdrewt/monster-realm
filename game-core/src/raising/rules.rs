//! Raising rule functions — focus-training (EV top-off → re-derive) and care
//! (bond raise). All pure and deterministic (ADR-0003 / ADR-0058): no clock,
//! no RNG, no I/O. The care cooldown time is read from `ctx.timestamp` in the
//! M9b reducer, never here.
//!
//! Both rules are **reject-not-clamp**: a maxed target stat / exhausted EV
//! budget / max bond returns `Err` so the M9b reducer rejects the action and
//! does NOT consume the food / burn the cooldown for nothing (M9 spec §3).
//! Stat derivation is **not** duplicated here — the topped-off EVs are fed back
//! through the single-source `derive_stats` (ADR-0016 derive-on-write).

use crate::monster::rules::derive_stats;
use crate::monster::types::{
    Bond, EVs, IVs, Level, Nature, StatBlock, StatKind, EV_PER_STAT_CAP, EV_TOTAL_CAP,
};

use super::types::{CareError, FocusTrainError, FocusTrainResult};

// The per-stat (252) and total (510) EV caps are imported from `monster::types`
// — one SSOT for the caps the `EVs` constructor enforces (ADR-0058 residual (b)
// resolved). They are NOT re-declared here; a single definition keeps
// `focus_train`'s top-off in lockstep with `EVs::new`'s rejection thresholds, so
// neither a too-high nor a too-low local copy can drift them apart.

/// Apply a focus-training food: grant `amount` EVs toward `target`, **topped off**
/// to the per-stat cap (252) AND the total-EV cap (510) — never overflowing —
/// then re-derive the monster's stats through the single-source `derive_stats`.
///
/// Returns the new `EVs` and re-derived `StatBlock` (the M9b reducer writes both
/// back). Reject-not-clamp, with precise variants in a pinned guard order
/// (ADR-0058 §2 — input-validity before state): `NoEffect` if `amount == 0`;
/// else `StatAtCap` if the target is already 252; else `BudgetExhausted` if the
/// total is already 510 (target below 252). After the guards the grant is always
/// `>= 1`, so a successful `Ok` always moves at least one EV (reject-not-no-op).
///
/// # Errors
/// `FocusTrainError` whenever the application would move zero EVs (see above).
/// (The returned `Result` — and `FocusTrainResult` — are both `#[must_use]`, so
/// the M9b reducer cannot silently drop the re-derived stats.)
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

/// Raise a monster's bond by `amount`, **saturating** at the maximum (`u8::MAX`).
///
/// Reject-not-clamp in a pinned guard order (ADR-0058 §3 — input-validity before
/// state): `NoEffect` if `amount == 0`; else `AtMaxBond` if bond is already at
/// the maximum (so the M9b reducer rejects before burning the care cooldown).
///
/// # Errors
/// `CareError` whenever the application would raise bond by zero (see above).
pub fn apply_care(bond: Bond, amount: u8) -> Result<Bond, CareError> {
    if amount == 0 {
        return Err(CareError::NoEffect);
    }
    if bond.value() == u8::MAX {
        return Err(CareError::AtMaxBond);
    }
    Ok(Bond::new(bond.value().saturating_add(amount)))
}

/// Fixed bond raise granted by one successful `care` (ptc5e-1 SSOT: moved here
/// from the M9b shell so the magnitude lives in game-core beside its consuming
/// rule `apply_care`, a sibling of `CHALLENGE_TTL_MS` / `RECRUIT_BASE_RATE` /
/// the EV caps). Documented as a playtest-tunable policy magnitude (M9 spec §6),
/// not a contract — retuning it is a one-line game-core edit + a value test.
pub const CARE_BOND_AMOUNT: u8 = 5;

/// Per-monster care cooldown in ms (6 h). Playtest-tunable (M9 spec §6). Moved to
/// game-core in ptc5e-1 (a single global duration is a sibling of `CHALLENGE_TTL_MS`,
/// not per-entity data like `heal_location_row.cooldown_ms`).
pub const CARE_COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;

/// True iff a cooldown has fully elapsed: `now_ms - last_ms >= cooldown_ms`
/// (ptc5e-1, mirroring `is_challenge_stale`). ONE cooldown-ready predicate shared
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
