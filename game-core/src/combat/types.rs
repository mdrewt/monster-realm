//! Combat value types — the cross-boundary contract for a single battle.
//!
//! All types are pure data (no I/O, no clock, no RNG — ADR-0003).
//! Serde derives keep server↔client serialisation in sync.

use serde::{Deserialize, Serialize};

use crate::monster::types::{Affinity, StatBlock};

// ===========================================================================
// Core combat types
// ===========================================================================

/// A monster projected into battle — only the fields the combat engine needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleMonster {
    pub species_id: u32,
    pub affinity: Affinity,
    pub level: u8,
    pub current_hp: u16,
    pub max_hp: u16,
    pub stats: StatBlock,
    pub known_skill_ids: Vec<u32>,
}

impl BattleMonster {
    /// Returns `true` when HP has reached 0 (the monster is out of battle).
    #[must_use]
    pub fn is_fainted(&self) -> bool {
        self.current_hp == 0
    }
}

/// One side of the battle: the active slot index and the full team roster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleSide {
    /// Index into `team` for the currently-active monster (u32 for SpacetimeType).
    pub active: u32,
    pub team: Vec<BattleMonster>,
}

impl BattleSide {
    /// Borrow the currently-active monster.
    #[must_use]
    pub fn active_monster(&self) -> &BattleMonster {
        &self.team[self.active as usize]
    }

    /// Mutably borrow the currently-active monster.
    pub fn active_monster_mut(&mut self) -> &mut BattleMonster {
        &mut self.team[self.active as usize]
    }

    /// `true` if any team member still has HP > 0.
    #[must_use]
    pub fn has_conscious_member(&self) -> bool {
        self.team.iter().any(|m| !m.is_fainted())
    }

    /// The index of the first non-fainted member that is NOT the current active.
    #[must_use]
    pub fn next_conscious_index(&self) -> Option<u32> {
        self.team
            .iter()
            .enumerate()
            .find(|(i, m)| *i as u32 != self.active && !m.is_fainted())
            .map(|(i, _)| i as u32)
    }
}

/// High-level outcome of the battle; `Ongoing` until a terminal condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum BattleOutcome {
    Ongoing,
    SideAWins,
    SideBWins,
    Fled,
}

/// The full mutable state of a battle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleState {
    pub side_a: BattleSide,
    pub side_b: BattleSide,
    pub outcome: BattleOutcome,
    pub turn_number: u16,
}

/// What a player chooses to do on their turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnChoice {
    Attack { skill_id: u32 },
    Swap { team_index: u32 },
}

/// A discriminant for which side of the battle we refer to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SideId {
    SideA,
    SideB,
}

/// Type-effectiveness bucket, derived from the raw effectiveness value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Effectiveness {
    Immune,
    NotVeryEffective,
    Neutral,
    SuperEffective,
}

/// Atomic event emitted by the battle resolver — consumed by UI and logging.
///
/// Marked `#[non_exhaustive]` so M14 can add new variants without breaking
/// exhaustive matches elsewhere.
///
/// DO NOT add `SpacetimeType` here — `BattleEvent` is transient (resolver return
/// value only, never stored in a table). Adding it would make new variants a
/// breaking wire-format change for old clients. See ADR-0042.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BattleEvent {
    Damage {
        side: SideId,
        amount: u16,
        effectiveness: Effectiveness,
    },
    Faint {
        side: SideId,
    },
    Switch {
        side: SideId,
        new_active: u32,
    },
    BattleEnd {
        winner: SideId,
    },
    Miss {
        side: SideId,
    },
}

/// Injected variance for a single turn — deterministic, caller-supplied.
///
/// All rolls are pre-computed by the caller (server or sim-harness), then
/// passed through so the resolver is a pure function of `(state, choices, variance)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnVariance {
    /// Damage roll for side A, must be in 85..=100.
    pub damage_roll_a: u8,
    /// Damage roll for side B, must be in 85..=100.
    pub damage_roll_b: u8,
    /// Accuracy roll for side A, must be in 0..=99.
    pub accuracy_roll_a: u8,
    /// Accuracy roll for side B, must be in 0..=99.
    pub accuracy_roll_b: u8,
    /// Determines A-goes-first on a speed tie (true = A first).
    pub speed_tie_breaker: bool,
}

impl TurnVariance {
    /// Derive a deterministic `TurnVariance` from a single u32 seed.
    ///
    /// Used by the server to convert a random u32 (from SpacetimeDB's
    /// `ctx.random()`) into the five rolls the resolver needs. The mapping is
    /// pure: replaying the same seed reproduces the same battle turn.
    #[must_use]
    pub fn from_ctx_random(seed: u32) -> TurnVariance {
        // Splitmix64-style mixing to derive independent values from one seed.
        let mut s = seed as u64;
        let mut next = || -> u32 {
            s = s.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            (z ^ (z >> 31)) as u32
        };

        TurnVariance {
            damage_roll_a: 85 + (next() % 16) as u8,
            damage_roll_b: 85 + (next() % 16) as u8,
            accuracy_roll_a: (next() % 100) as u8,
            accuracy_roll_b: (next() % 100) as u8,
            speed_tie_breaker: next() & 1 == 1,
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Fixture builders
    // -----------------------------------------------------------------------

    pub fn make_stat_block(atk: u16, def: u16, spd: u16) -> StatBlock {
        StatBlock {
            hp: 100,
            attack: atk,
            defense: def,
            speed: spd,
            sp_attack: 50,
            sp_defense: 50,
        }
    }

    pub fn make_battle_monster(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: hp,
            max_hp: hp,
            stats: make_stat_block(40, 40, speed),
            known_skill_ids: vec![1],
        }
    }

    pub fn make_battle_side(monster: BattleMonster) -> BattleSide {
        BattleSide {
            active: 0,
            team: vec![monster],
        }
    }

    // -----------------------------------------------------------------------
    // BattleMonster tests
    // -----------------------------------------------------------------------

    /// Kills: an impl that uses `current_hp < 0` or some other off-by-one condition.
    #[test]
    fn is_fainted_returns_true_when_hp_is_zero() {
        let m = make_battle_monster(Affinity::Fire, 0, 50);
        assert!(m.is_fainted(), "monster with 0 HP must be fainted");
    }

    /// Kills: an impl that returns `true` for any positive HP.
    #[test]
    fn is_fainted_returns_false_when_hp_is_positive() {
        let m = make_battle_monster(Affinity::Fire, 1, 50);
        assert!(!m.is_fainted(), "monster with 1 HP must not be fainted");
    }

    // -----------------------------------------------------------------------
    // BattleSide tests
    // -----------------------------------------------------------------------

    /// Kills: an impl where `active_monster` returns the wrong team member.
    #[test]
    fn active_monster_returns_correct_member() {
        let m = make_battle_monster(Affinity::Water, 50, 30);
        let side = make_battle_side(m.clone());
        assert_eq!(side.active_monster().species_id, m.species_id);
        assert_eq!(side.active_monster().affinity, Affinity::Water);
    }

    /// Kills: an impl of `has_conscious_member` that returns false when the
    /// active monster has HP remaining.
    #[test]
    fn has_conscious_member_true_when_active_is_alive() {
        let m = make_battle_monster(Affinity::Fire, 10, 30);
        let side = make_battle_side(m);
        assert!(side.has_conscious_member());
    }

    /// Kills: an impl that doesn't check the full team (only the active slot).
    #[test]
    fn has_conscious_member_false_when_all_fainted() {
        let m = make_battle_monster(Affinity::Fire, 0, 30);
        let side = make_battle_side(m);
        assert!(!side.has_conscious_member());
    }

    /// Kills: an impl where `next_conscious_index` returns the active index itself.
    #[test]
    fn next_conscious_index_skips_active() {
        let m0 = make_battle_monster(Affinity::Fire, 10, 30);
        let m1 = make_battle_monster(Affinity::Water, 10, 30);
        let side = BattleSide {
            active: 0,
            team: vec![m0, m1],
        };
        let idx = side.next_conscious_index();
        assert_eq!(idx, Some(1), "should skip the active slot");
    }

    /// Kills: an impl that returns fainted members as candidates.
    #[test]
    fn next_conscious_index_skips_fainted_members() {
        let m0 = make_battle_monster(Affinity::Fire, 10, 30);
        let m1 = make_battle_monster(Affinity::Water, 0, 30); // fainted
        let m2 = make_battle_monster(Affinity::Plant, 20, 30);
        let side = BattleSide {
            active: 0,
            team: vec![m0, m1, m2],
        };
        let idx = side.next_conscious_index();
        assert_eq!(
            idx,
            Some(2),
            "must skip fainted member 1, return conscious member 2"
        );
    }

    /// Kills: an impl that returns `Some` even when no backup is available.
    #[test]
    fn next_conscious_index_none_when_only_active_is_left() {
        let m = make_battle_monster(Affinity::Fire, 10, 30);
        let side = make_battle_side(m);
        assert_eq!(
            side.next_conscious_index(),
            None,
            "solo team has no next conscious member"
        );
    }

    // -----------------------------------------------------------------------
    // Serde round-trips
    // -----------------------------------------------------------------------

    /// Kills: a serde impl that drops fields or changes the variant encoding.
    #[test]
    fn battle_event_damage_serde_round_trip() {
        let ev = BattleEvent::Damage {
            side: SideId::SideA,
            amount: 42,
            effectiveness: Effectiveness::SuperEffective,
        };
        let s = ron::to_string(&ev).unwrap();
        let back: BattleEvent = ron::from_str(&s).unwrap();
        assert_eq!(ev, back);
    }

    /// Kills: a serde impl that forgets the `non_exhaustive` pattern or drops variants.
    #[test]
    fn battle_event_miss_serde_round_trip() {
        let ev = BattleEvent::Miss {
            side: SideId::SideB,
        };
        let s = ron::to_string(&ev).unwrap();
        let back: BattleEvent = ron::from_str(&s).unwrap();
        assert_eq!(ev, back);
    }

    /// Kills: a serde impl where TurnVariance round-trip loses any field.
    #[test]
    fn turn_variance_serde_round_trip() {
        let tv = TurnVariance {
            damage_roll_a: 95,
            damage_roll_b: 87,
            accuracy_roll_a: 42,
            accuracy_roll_b: 99,
            speed_tie_breaker: true,
        };
        let s = ron::to_string(&tv).unwrap();
        let back: TurnVariance = ron::from_str(&s).unwrap();
        assert_eq!(tv, back);
    }

    // -----------------------------------------------------------------------
    // Property tests
    // -----------------------------------------------------------------------

    fn arb_affinity() -> impl Strategy<Value = Affinity> {
        prop_oneof![
            Just(Affinity::Fire),
            Just(Affinity::Water),
            Just(Affinity::Plant),
            Just(Affinity::Electric),
            Just(Affinity::Earth),
            Just(Affinity::Wind),
            Just(Affinity::Light),
            Just(Affinity::Dark),
        ]
    }

    proptest! {
        /// Kills: any BattleMonster serde impl that is not a lossless round-trip.
        #[test]
        fn battle_monster_serde_round_trip(
            species_id in 0u32..1000,
            affinity in arb_affinity(),
            level in 1u8..=100,
            hp in 1u16..=500,
        ) {
            let m = BattleMonster {
                species_id,
                affinity,
                level,
                current_hp: hp,
                max_hp: hp,
                stats: make_stat_block(50, 50, 50),
                known_skill_ids: vec![1, 2],
            };
            let s = ron::to_string(&m).unwrap();
            let back: BattleMonster = ron::from_str(&s).unwrap();
            prop_assert_eq!(m, back);
        }

        /// Kills: any BattleState serde impl that drops nested fields.
        #[test]
        fn battle_state_serde_round_trip(
            hp_a in 1u16..=200,
            hp_b in 1u16..=200,
            turn in 0u16..=1000,
        ) {
            let state = BattleState {
                side_a: BattleSide {
                    active: 0,
                    team: vec![make_battle_monster(Affinity::Fire, hp_a, 50)],
                },
                side_b: BattleSide {
                    active: 0,
                    team: vec![make_battle_monster(Affinity::Water, hp_b, 40)],
                },
                outcome: BattleOutcome::Ongoing,
                turn_number: turn,
            };
            let s = ron::to_string(&state).unwrap();
            let back: BattleState = ron::from_str(&s).unwrap();
            prop_assert_eq!(state, back);
        }
    }
}
