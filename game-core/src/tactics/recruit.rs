//! Recruit (design §5) — the tactical form of the standing recruit rulings. bt-5 STUB (red phase).

use serde::{Deserialize, Serialize};

use crate::content::Species;
use crate::monster::types::{Level, MonsterInstance};

use super::events::RecruitResultEvent;
use super::resolve::TacticalState;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecruitOdds {
    pub pct: u8,
    pub base: u8,
    pub bait: u8,
    pub weakened: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecruitError {
    BaitBonus { bait_bonus: u16 },
    UnknownUnit { id: u32 },
    TargetGone { id: u32 },
}

/// # Errors
/// stub
pub fn recruit_odds(_max_hp: u16, _hp: u16, _bait_bonus: u16) -> Result<RecruitOdds, RecruitError> {
    todo!("bt-5")
}

#[must_use]
pub fn recruit_roll_succeeds(_pct: u8, _roll: u64) -> bool {
    todo!("bt-5")
}

/// # Errors
/// stub
pub fn recruit_preflight(
    _state: &TacticalState,
    _unit: u32,
    _target: u32,
    _bait_bonus: u16,
) -> Result<(), RecruitError> {
    todo!("bt-5")
}

/// # Errors
/// stub
pub fn resolve_recruit(
    _state: &mut TacticalState,
    _unit: u32,
    _target: u32,
    _bait_bonus: u16,
) -> Result<RecruitResultEvent, RecruitError> {
    todo!("bt-5")
}

#[must_use]
pub fn rebuild_recruited(_seed: u32, _species: &Species, _level: Level) -> MonsterInstance {
    todo!("bt-5")
}
