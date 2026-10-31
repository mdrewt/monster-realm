//! Rewards (design §7) — the in-battle ledger. bt-5 STUB (red phase).

use serde::{Deserialize, Serialize};

use crate::monster::types::Affinity;

use super::resolve::TacticalState;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub unit: u32,
    pub victim: u32,
    pub xp: u32,
    pub essence: u32,
    pub affinity: Affinity,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    pub credits: Vec<Credit>,
    pub currency: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RewardError {
    UnknownUnit { id: u32 },
    NotDefeated { id: u32 },
    AlreadyCredited { id: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Award {
    pub unit: u32,
    pub xp: u32,
    pub essence: Vec<(Affinity, u32)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payout {
    pub awards: Vec<Award>,
    pub currency: u64,
}

/// # Errors
/// stub
pub fn on_unit_defeated(
    _ledger: &mut Ledger,
    _state: &TacticalState,
    _killer: u32,
    _victim: u32,
    _victim_bst: u16,
) -> Result<(), RewardError> {
    todo!("bt-5")
}

#[must_use]
pub fn pay(_ledger: &Ledger, _state: &TacticalState) -> Payout {
    todo!("bt-5")
}
