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
use crate::monster::types::{Bond, EVs, IVs, Level, Nature, StatBlock, StatKind};

use super::types::{CareError, FocusTrainError, FocusTrainResult};

/// Per-stat EV cap. Mirrors the threshold `EVs::new` rejects above. Drift from
/// the real (private) `monster::types` cap is caught BOTH ways by the gating
/// teeth: a too-HIGH value makes a near-cap grant exceed the constructor limit →
/// the `EVs::new(...).expect(...)` in `focus_train` panics; a too-LOW value
/// rejects/underflows at a boundary → `focus_train_cap_const_agrees_with_evs_constructor`
/// fails. The permanent fix — re-export these caps `pub(crate)` from
/// `monster::types` and import them — is deferred to M9b (it already edits that
/// file); see ADR-0058 follow-ups.
const EV_PER_STAT_CAP: u16 = 252;
/// Total-EV budget cap. Mirrors `EVs::new`'s total threshold (see above).
const EV_TOTAL_CAP: u16 = 510;

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
