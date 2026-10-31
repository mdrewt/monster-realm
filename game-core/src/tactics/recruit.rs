//! Recruit — design §5, the tactical form of the standing recruit rulings.
//!
//! The turn machine (`queue`) is the ONE home of the verb's legality: wild battles only, a
//! player-owned recruiter, a conscious wild target that is Manhattan-adjacent, party headroom
//! (the injected `Hooks::recruit_headroom` result, consulted at submit and at pop), the full
//! 6-of-6 budget and "the only entry of the turn". This module owns what happens behind that gate:
//!
//! - [`recruit_odds`] — the carried `recruit_chance` (‰, unchanged) quantized to whole percent so
//!   the forecast shown is the chance rolled, split into line items that always sum;
//! - [`recruit_preflight`] — the checks the turn machine cannot make (the bait's bonus, the bound
//!   ids). The shell calls it from `Hooks::validate_delegated`, so a bad bait row halts the entry
//!   BEFORE the bait is debited (R-21r-a-CONTENTLOAD) and [`resolve_recruit`] cannot fail after it;
//! - [`resolve_recruit`] — one roll from the private stream; success removes the wild from the
//!   board and the initiative (`Recruited` is terminal: it never acts, is never swept as a KO and
//!   so never fires the reward hook, and never re-enters a later round's order);
//! - [`rebuild_recruited`] — the monster the player receives: rebuilt from the wild's seed.
//!
//! Failure changes nothing but the stream: the turn and the bait were already spent by the
//! executor, and the odds are a pure function of HP and bait (no hidden stacking).

use serde::{Deserialize, Serialize};

use crate::content::Species;
use crate::monster::rolls::build_monster;
use crate::monster::types::{Level, MonsterInstance};
use crate::taming::rules::{recruit_chance, RECRUIT_BASE_RATE};

use super::events::RecruitResultEvent;
use super::resolve::{draw, TacticalState, UnitState};

/// The largest bait bonus (‰) — the carried rule's domain and the item validator's cap.
const MAX_BAIT_BONUS: u16 = 1000;

/// The forecast line items (design §5): `base + bait + weakened == pct`, and `pct` is what rolls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecruitOdds {
    pub pct: u8,
    pub base: u8,
    pub bait: u8,
    pub weakened: u8,
}

/// Why a recruit cannot be resolved (checked in declaration order). Reject, never clamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecruitError {
    /// The bait's bonus exceeds 1000 ‰ (a content row the validator should have refused).
    BaitBonus { bait_bonus: u16 },
    /// The recruiter or the target is not in the battle.
    UnknownUnit { id: u32 },
    /// The target is no longer conscious (fainted, at 0 HP, or already recruited).
    TargetGone { id: u32 },
}

/// The odds of a recruit on a wild at `hp` of `max_hp` with a bait worth `bait_bonus` ‰:
/// `pct = recruit_chance(max_hp, hp, 80, bait_bonus) / 10`; `base = 80 / 10 = 8`;
/// `bait = min(bait_bonus / 10, pct − base)` (the `min` bites only at the 1000 ‰ cap, so the lines
/// still sum); `weakened = pct − base − bait` (the floored carries land here).
/// A wild at 20 % HP with bait 150 ‰ → 630 ‰ → `{pct 63, base 8, bait 15, weakened 40}`.
///
/// # Errors
/// `bait_bonus > 1000` → [`RecruitError::BaitBonus`].
pub fn recruit_odds(max_hp: u16, hp: u16, bait_bonus: u16) -> Result<RecruitOdds, RecruitError> {
    if bait_bonus > MAX_BAIT_BONUS {
        return Err(RecruitError::BaitBonus { bait_bonus });
    }
    let permille = recruit_chance(max_hp, hp, RECRUIT_BASE_RATE, bait_bonus);
    // permille ≤ 1000, RECRUIT_BASE_RATE ≤ permille and bait_bonus ≤ 1000: every quotient fits a u8.
    let pct = u8::try_from(permille / 10).unwrap_or(u8::MAX);
    let base = u8::try_from(RECRUIT_BASE_RATE / 10).unwrap_or(u8::MAX);
    let bait = u8::try_from(bait_bonus / 10)
        .unwrap_or(u8::MAX)
        .min(pct.saturating_sub(base));
    let weakened = pct.saturating_sub(base).saturating_sub(bait);
    Ok(RecruitOdds {
        pct,
        base,
        bait,
        weakened,
    })
}

/// Whether `roll` succeeds against `pct`: `roll % 100 < pct`.
#[must_use]
pub fn recruit_roll_succeeds(pct: u8, roll: u64) -> bool {
    roll % 100 < u64::from(pct)
}

/// The checks behind the turn machine's gate, pure: the bait bonus (`BaitBonus`), the recruiter
/// (`UnknownUnit`), the target (`UnknownUnit`, then `TargetGone` unless conscious).
///
/// # Errors
/// See [`RecruitError`].
pub fn recruit_preflight(
    state: &TacticalState,
    unit: u32,
    target: u32,
    bait_bonus: u16,
) -> Result<(), RecruitError> {
    if bait_bonus > MAX_BAIT_BONUS {
        return Err(RecruitError::BaitBonus { bait_bonus });
    }
    state
        .unit(unit)
        .ok_or(RecruitError::UnknownUnit { id: unit })?;
    let wild = state
        .unit(target)
        .ok_or(RecruitError::UnknownUnit { id: target })?;
    if !wild.is_conscious() {
        return Err(RecruitError::TargetGone { id: target });
    }
    Ok(())
}

/// Resolve a validated, paid Recruit entry: [`recruit_preflight`], then EXACTLY ONE draw from the
/// private stream judged by [`recruit_roll_succeeds`] against the target's live odds. Success:
/// the target becomes `Recruited` (HP untouched) and leaves the initiative and the queue.
/// Failure: nothing else changes. Returns the `RecruitResult` event (`pct` = the odds rolled).
///
/// # Errors
/// The preflight's, with `state` untouched (no draw).
pub fn resolve_recruit(
    state: &mut TacticalState,
    unit: u32,
    target: u32,
    bait_bonus: u16,
) -> Result<RecruitResultEvent, RecruitError> {
    recruit_preflight(state, unit, target, bait_bonus)?;
    let wild = state
        .unit(target)
        .ok_or(RecruitError::UnknownUnit { id: target })?;
    let odds = recruit_odds(wild.max_hp(), wild.cur_hp, bait_bonus)?;
    let success = recruit_roll_succeeds(odds.pct, draw(state));
    if success {
        if let Some(wild) = state.unit_mut(target) {
            wild.state = UnitState::Recruited;
        }
        state.remove_from_initiative(target);
    }
    Ok(RecruitResultEvent {
        unit,
        target,
        success,
        pct: odds.pct,
    })
}

/// The monster a successful recruit grants: the wild rebuilt from its per-wild `seed`
/// (`encounter::wild_seed`) at `level` — the carried `build_monster`: exact genes
/// (`roll_individuality(seed)`), full HP, the level's base XP and no essence (a recruit earns
/// nothing in battle).
#[must_use]
pub fn rebuild_recruited(seed: u32, species: &Species, level: Level) -> MonsterInstance {
    build_monster(seed, species, level)
}
