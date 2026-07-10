//! Passive ability rules — per-species hooks applied at entry and per-turn.
//!
//! Abilities are data-driven: content defines which species has which ability,
//! and this module provides the pure rule functions that execute those effects.
//!
//! # Pipeline integration
//!
//! Two hook functions are exported for callers to wire into the battle pipeline:
//! - [`apply_entry_ability`] — call when a monster enters the active slot
//!   (battle start or switch-in).
//! - [`apply_ability_modifiers`] — call once per turn before pre-turn action
//!   blocking checks (enforces ongoing passives like status immunity).
//!
//! These hooks are intentionally NOT wired into [`super::resolve::resolve_full_turn`]
//! in this slice — the server wiring is a subsequent slice's job (when the server
//! is ready to construct and pass an [`AbilityStore`]). Exporting them here makes
//! the contract stable and testable independently.

use serde::{Deserialize, Serialize};

use super::status::BattleStatusStore;
use super::types::{BattleState, SideId, StatusEffect};

// ===========================================================================
// StatusKind — payload-free discriminant for immunity checks
// ===========================================================================

/// Payload-free discriminant for status immunity.
///
/// Mirrors [`StatusEffect`] variants without the `turns_remaining` payload so
/// `StatusImmunity` content is unambiguous: `StatusImmunity(immune_to: Sleep)`
/// is valid and means "immune to Sleep regardless of remaining turns".
///
/// Exhaustive: a new [`StatusEffect`] variant requires adding a matching
/// `StatusKind` variant AND updating [`StatusKind::matches`] — the dual
/// exhaustive `match` IS the OCP gate for this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatusKind {
    Poison,
    Burn,
    Paralysis,
    Sleep,
    Freeze,
}

impl StatusKind {
    /// Returns `true` when `effect` has the same variant as `self`.
    /// The explicit arm listing documents the StatusKind→StatusEffect mapping;
    /// adding a new `StatusKind` variant requires adding a matching arm here.
    #[must_use]
    #[allow(clippy::match_like_matches_macro)]
    pub fn matches(self, effect: &StatusEffect) -> bool {
        match (self, effect) {
            (StatusKind::Poison, StatusEffect::Poison) => true,
            (StatusKind::Burn, StatusEffect::Burn) => true,
            (StatusKind::Paralysis, StatusEffect::Paralysis) => true,
            (StatusKind::Sleep, StatusEffect::Sleep { .. }) => true,
            (StatusKind::Freeze, StatusEffect::Freeze) => true,
            _ => false,
        }
    }
}

// ===========================================================================
// AbilityEffect — exhaustive passive ability effect enum (OCP gate)
// ===========================================================================

/// A passive ability's game effect. Exhaustive — do NOT add `#[non_exhaustive]`.
///
/// A new variant forces a compile-time exhaustive-`match` update at every
/// resolution site (OCP gate, ADR-0010). Every site must handle every variant;
/// this is intentional and differs from `BattleEvent` which IS `#[non_exhaustive]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AbilityEffect {
    /// Complete immunity to a specific status condition.
    ///
    /// Any matching status is cleared per-turn via [`apply_ability_modifiers`]
    /// and on entry via [`apply_entry_ability`]. Matching is by kind
    /// (see [`StatusKind`]): a Sleep-immune monster is immune to Sleep regardless
    /// of `turns_remaining`.
    StatusImmunity { immune_to: StatusKind },

    /// Heal `max_hp / denom` HP (minimum 1) when this monster enters the active slot.
    ///
    /// `denom` must be ≥ 2 (validated by [`crate::content::validate_abilities`]).
    /// A `denom` of 0 or 1 would grant a free full-heal on every entry, which
    /// is rejected as invalid content.
    EntryHeal { denom: u16 },
}

// ===========================================================================
// AbilityStore — per-slot ability tracker, analogous to BattleStatusStore
// ===========================================================================

/// Per-slot passive ability tracker for both sides of a battle.
///
/// Each slot holds the [`AbilityEffect`] for the monster in that slot, or `None`
/// if the species has no ability. Populated from species content at battle start.
pub struct AbilityStore {
    pub side_a: Vec<Option<AbilityEffect>>,
    pub side_b: Vec<Option<AbilityEffect>>,
}

impl AbilityStore {
    /// Create an empty (all `None`) store for the given team sizes.
    pub fn new(a_size: usize, b_size: usize) -> Self {
        AbilityStore {
            side_a: vec![None; a_size],
            side_b: vec![None; b_size],
        }
    }
}

// ===========================================================================
// Entry hook
// ===========================================================================

/// Apply on-entry passive effects for the currently-active monster on `side`.
///
/// Call when a monster enters the active slot: at battle start and on any
/// switch-in. Handles `EntryHeal` (restores HP) and `StatusImmunity` (clears
/// any matching status already in the slot — normally None on entry, but
/// handles edge cases where status persists across a switch).
pub fn apply_entry_ability(
    state: &mut BattleState,
    side: SideId,
    abilities: &AbilityStore,
    status: &mut BattleStatusStore,
) {
    let active_idx = match side {
        SideId::SideA => state.side_a.active as usize,
        SideId::SideB => state.side_b.active as usize,
    };

    let ability = match side {
        SideId::SideA => abilities.side_a.get(active_idx).and_then(|a| a.as_ref()),
        SideId::SideB => abilities.side_b.get(active_idx).and_then(|a| a.as_ref()),
    };

    let ability = match ability {
        Some(a) => a,
        None => return,
    };

    match ability {
        AbilityEffect::EntryHeal { denom } => {
            let denom = *denom;
            // Callers must validate via validate_abilities before constructing AbilityStore.
            debug_assert!(
                denom >= 2,
                "EntryHeal denom {denom} bypassed validate_abilities — must be >= 2"
            );
            let monster = match side {
                SideId::SideA => state.side_a.active_monster_mut(),
                SideId::SideB => state.side_b.active_monster_mut(),
            };
            // No heal when fainted or already at full HP.
            if !monster.is_fainted() && monster.current_hp < monster.max_hp {
                let heal = (monster.max_hp / denom).max(1);
                monster.current_hp = monster.current_hp.saturating_add(heal).min(monster.max_hp);
            }
        }
        AbilityEffect::StatusImmunity { immune_to } => {
            // Clear matching status on entry (handles edge cases where status
            // persists into the slot before the immunity can act per-turn).
            let status_slot = match side {
                SideId::SideA => status.side_a.get_mut(active_idx),
                SideId::SideB => status.side_b.get_mut(active_idx),
            };
            if let Some(slot) = status_slot {
                if let Some(current) = slot.as_ref() {
                    if immune_to.matches(current) {
                        *slot = None;
                    }
                }
            }
        }
    }
}

// ===========================================================================
// Per-turn modifier hook
// ===========================================================================

/// Apply per-turn passive modifiers (e.g. status immunity) for both active monsters.
///
/// Call at the start of each turn before pre-turn action-blocking checks
/// (so immunity takes effect before Paralysis/Sleep/Freeze blocking is evaluated).
/// Silently clears any status that the active monster's ability immunises against.
/// Emits no events — immunity filtering is a silent per-turn correction.
pub fn apply_ability_modifiers(
    state: &BattleState,
    status: &mut BattleStatusStore,
    abilities: &AbilityStore,
) {
    for side_id in [SideId::SideA, SideId::SideB] {
        let active_idx = match side_id {
            SideId::SideA => state.side_a.active as usize,
            SideId::SideB => state.side_b.active as usize,
        };

        let ability = match side_id {
            SideId::SideA => abilities.side_a.get(active_idx).and_then(|a| a.as_ref()),
            SideId::SideB => abilities.side_b.get(active_idx).and_then(|a| a.as_ref()),
        };

        if let Some(AbilityEffect::StatusImmunity { immune_to }) = ability {
            let status_slot = match side_id {
                SideId::SideA => status.side_a.get_mut(active_idx),
                SideId::SideB => status.side_b.get_mut(active_idx),
            };
            if let Some(slot) = status_slot {
                if let Some(current) = slot.as_ref() {
                    if immune_to.matches(current) {
                        *slot = None;
                    }
                }
            }
        }
    }
}
