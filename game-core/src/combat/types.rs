//! Combat value types — the cross-boundary contract for a single battle.
//!
//! All types are pure data (no I/O, no clock, no RNG — ADR-0003).
//! Serde derives keep server↔client serialisation in sync.

use serde::{Deserialize, Serialize};

use crate::monster::types::{Affinity, StatBlock};
// WeatherEffect is defined in weather.rs (sibling module); used in BattleState.weather
// and BattleEvent::WeatherSet. No circular type dependency: BattleState → WeatherEffect
// is one-way; WeatherEffect does not contain BattleState.
use super::weather::WeatherEffect;

// ===========================================================================
// Status effects (moved here from status.rs to avoid circular import with
// BattleMonster.status — status.rs re-exports this for backward-compat)
// ===========================================================================

/// A per-monster status condition. Exhaustive `match` required at every
/// resolution site — a new variant forces a compile error (ADR-0010 OCP gate).
///
/// `SpacetimeType` is cfg-gated: the type is wired into `BattleMonster` which
/// is nested inside `BattleState` stored in the `battle` table (m14b, ADR-0093).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum StatusEffect {
    Poison,
    Burn,
    Paralysis,
    Sleep { turns_remaining: u8 },
    Freeze,
}

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
    /// Per-monster status condition persisted across turns (m14b, ADR-0093).
    /// `#[serde(default)]` ensures additive schema compat: old `battle.state`
    /// rows deserialize `status = None` (ADR-0006).
    #[serde(default)]
    pub status: Option<StatusEffect>,
}

impl BattleMonster {
    /// Returns `true` when HP has reached 0 (the monster is out of battle).
    #[must_use]
    pub fn is_fainted(&self) -> bool {
        self.current_hp == 0
    }
}

/// Why a checked swap was rejected (game-core-internal; never stored/sent — no serde/SpacetimeType). See ADR-0053.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapError {
    /// `idx` is past the end of `team` (also covers an empty team).
    OutOfBounds,
    /// The target slot's monster has fainted (`current_hp == 0`).
    Fainted,
}

/// One side of the battle: the active slot index and the full team roster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleSide {
    /// Index into `team` for the currently-active monster (u32 for SpacetimeType).
    /// Mutate ONLY via [`BattleSide::set_active`], the sole sanctioned mutator
    /// (field stays pub this slice; full privatization parked — ADR-0053).
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

    /// Set the active slot to `idx`, rejecting illegal swaps (reject-not-clamp, ADR-0053).
    /// The ONLY sanctioned mutator of `active`: makes an out-of-range or fainted active
    /// unreachable via the resolver. Bounds is checked BEFORE the fainted index, so an
    /// out-of-range index can never panic-index `team[idx]`.
    /// Returns `Err(SwapError::OutOfBounds)` if `idx as usize >= team.len()`,
    /// `Err(SwapError::Fainted)` if the target is fainted, else sets `active` and returns `Ok(())`.
    /// On any `Err`, `active` is left unchanged.
    pub fn set_active(&mut self, idx: u32) -> Result<(), SwapError> {
        if idx as usize >= self.team.len() {
            return Err(SwapError::OutOfBounds);
        }
        if self.team[idx as usize].is_fainted() {
            return Err(SwapError::Fainted);
        }
        self.active = idx;
        Ok(())
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
    /// Active field weather — ticks down each turn and clears on expiry (M14d,
    /// ADR-0095). `#[serde(default)]` ensures additive schema compat (ADR-0006):
    /// old `battle.state` rows deserialise `weather = None`.
    #[serde(default)]
    pub weather: Option<WeatherEffect>,
}

/// What a player chooses to do on their turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnChoice {
    Attack {
        skill_id: u32,
    },
    Swap {
        team_index: u32,
    },
    /// The side takes no action — used by [`resolve_full_turn`] when a status
    /// effect blocks the side's intended choice (Paralysis, Sleep, Freeze).
    Pass,
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
    /// A status condition was applied to the monster at `slot` on the given side this
    /// turn (by a skill with `applies_status`). Emitted by the resolver and applied
    /// to `BattleStatusStore` in `run_post_turn_phases` AFTER the turn's DoT step so
    /// the newly-applied status takes effect the FOLLOWING turn (ADR-0096 §D1).
    ///
    /// `slot` is `state.side_X.active` captured at emission time inside
    /// `resolve_one_attack`. The targeted monster did not faint from THIS attack
    /// (the `!fainted` guard ensures that), but DoT (Phase 3) or weather chip
    /// (Phase 3.5) can subsequently faint it and trigger an auto-switch before
    /// Phase 4.5 writes the status. Carrying the slot in the event makes the target
    /// unambiguous; Phase 4.5 drops the write if the targeted monster is no longer
    /// conscious (ADR-0099 D1/D2).
    StatusApplied {
        side: SideId,
        /// Team slot index of the targeted monster, captured at emission time.
        slot: u32,
        status: StatusEffect,
    },
    /// Damage applied at end of turn by Poison (`max_hp/8`) or Burn (`max_hp/16`).
    StatusDamage {
        side: SideId,
        amount: u16,
    },
    /// A side's action was skipped due to Paralysis, Sleep, or Freeze.
    ActionBlocked {
        side: SideId,
    },
    /// A status condition expired naturally (Sleep reached 0 turns, Freeze thawed).
    /// `slot` is the team-index of the monster whose status was cured (RT-S14-01 fix).
    StatusCured {
        side: SideId,
        /// Team slot index that was cured — distinguishes bench cures from active-slot cures.
        slot: u32,
    },
    /// Weather was set by a skill or ability. Carries the new weather state
    /// (including `turns_remaining`) so the client can display the weather banner.
    WeatherSet {
        weather: WeatherEffect,
    },
    /// End-of-turn chip damage dealt by Sandstorm or Hail to a non-immune active monster.
    WeatherDamage {
        side: SideId,
        amount: u16,
    },
    /// The active weather expired (turns_remaining reached 0 after tick).
    WeatherExpired,
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
            status: None,
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
    // BattleSide::set_active — checked swap legality (M8.6a, ADR-0053)
    //
    // Contract (parse-don't-validate, reject-not-clamp):
    //   - Err(SwapError::OutOfBounds) if `idx as usize >= team.len()` (incl. empty)
    //   - else Err(SwapError::Fainted) if `team[idx].is_fainted()`
    //   - else set `active = idx`, return Ok(())
    //   - bounds is checked BEFORE the fainted index; on ANY Err, `active` is unchanged.
    // -----------------------------------------------------------------------

    /// Kills: a setter that fails to actually move `active` on the Ok path, or
    /// that rejects a legal conscious target.
    #[test]
    fn set_active_ok_moves_active_to_conscious_member() {
        let m0 = make_battle_monster(Affinity::Fire, 10, 30);
        let m1 = make_battle_monster(Affinity::Water, 10, 30);
        let mut side = BattleSide {
            active: 0,
            team: vec![m0, m1],
        };
        let res = side.set_active(1);
        assert_eq!(
            res,
            Ok(()),
            "swapping to a conscious in-range slot must succeed"
        );
        assert_eq!(
            side.active, 1,
            "active must move to the requested slot on Ok"
        );
    }

    /// Kills: a setter using `idx > len` (off-by-one) instead of `idx >= len`, or
    /// one that mutates `active` before/despite returning an OutOfBounds error.
    #[test]
    fn set_active_out_of_bounds_at_len_rejects_and_leaves_active_unchanged() {
        let m0 = make_battle_monster(Affinity::Fire, 10, 30);
        let m1 = make_battle_monster(Affinity::Water, 10, 30);
        let mut side = BattleSide {
            active: 0,
            team: vec![m0, m1],
        };
        let res = side.set_active(2); // len == 2 → first invalid index
        assert_eq!(
            res,
            Err(SwapError::OutOfBounds),
            "idx == team.len() must be OutOfBounds (reject, not clamp)"
        );
        assert_eq!(
            side.active, 0,
            "TEETH: active must be UNCHANGED on an OutOfBounds error"
        );
    }

    /// Kills: a setter that panics or wraps on a huge index (e.g. `idx as usize`
    /// arithmetic) instead of returning OutOfBounds.
    #[test]
    fn set_active_u32_max_rejects_without_panic() {
        let m0 = make_battle_monster(Affinity::Fire, 10, 30);
        let m1 = make_battle_monster(Affinity::Water, 10, 30);
        let mut side = BattleSide {
            active: 0,
            team: vec![m0, m1],
        };
        let res = side.set_active(u32::MAX);
        assert_eq!(
            res,
            Err(SwapError::OutOfBounds),
            "u32::MAX index must be OutOfBounds, no panic"
        );
        assert_eq!(side.active, 0, "active unchanged on OutOfBounds");
    }

    /// Kills: a setter that indexes the (empty) team before the bounds check, which
    /// would panic instead of returning OutOfBounds.
    #[test]
    fn set_active_empty_team_rejects_without_panic() {
        let mut side = BattleSide {
            active: 0,
            team: vec![],
        };
        let res = side.set_active(0);
        assert_eq!(
            res,
            Err(SwapError::OutOfBounds),
            "set_active(0) on an empty team must be OutOfBounds, not a panic"
        );
        assert_eq!(side.active, 0, "active unchanged on OutOfBounds");
    }

    /// Kills: a setter that ignores the fainted check (or checks the wrong slot),
    /// or that mutates `active` despite returning Fainted.
    #[test]
    fn set_active_fainted_target_rejects_and_leaves_active_unchanged() {
        let conscious = make_battle_monster(Affinity::Fire, 10, 30);
        let fainted = make_battle_monster(Affinity::Water, 0, 30); // hp 0 → fainted
        let mut side = BattleSide {
            active: 0,
            team: vec![conscious, fainted],
        };
        let res = side.set_active(1); // slot 1 is fainted
        assert_eq!(
            res,
            Err(SwapError::Fainted),
            "swapping to a fainted member must be rejected as Fainted"
        );
        assert_eq!(
            side.active, 0,
            "TEETH: active must be UNCHANGED on a Fainted error"
        );
    }

    /// Order-pinning: bounds is checked BEFORE the fainted index. With every
    /// in-range slot fainted, a large OOB index must still return OutOfBounds
    /// (NOT Fainted, NOT a panic) — proving the bounds check precedes the
    /// `team[idx]` fainted-index access.
    ///
    /// Kills: a setter that checks `team[idx].is_fainted()` before bounds (would
    /// panic on the OOB index) or that returns Fainted for an out-of-range idx.
    #[test]
    fn set_active_bounds_checked_before_fainted_index() {
        let f0 = make_battle_monster(Affinity::Fire, 0, 30); // fainted
        let f1 = make_battle_monster(Affinity::Water, 0, 30); // fainted
        let mut side = BattleSide {
            active: 0,
            team: vec![f0, f1],
        };
        let res = side.set_active(99); // far out of bounds
        assert_eq!(
            res,
            Err(SwapError::OutOfBounds),
            "TEETH: bounds must be checked before the fainted index — an OOB idx \
             yields OutOfBounds, never Fainted, never a panic"
        );
        assert_eq!(side.active, 0, "active unchanged on OutOfBounds");
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
                status: None,
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
                weather: None,
            };
            let s = ron::to_string(&state).unwrap();
            let back: BattleState = ron::from_str(&s).unwrap();
            prop_assert_eq!(state, back);
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: known-answer vectors pin the exact
    // splitmix64-style derivation in `from_ctx_random` (12 survivors:
    // XOR/shift mixing + the `& 1 == 1` parity gate). Determinism contract:
    // replaying a stored seed must reproduce the same battle turn forever.
    // -----------------------------------------------------------------------

    /// Kills: all bit-mixing and parity mutants in `from_ctx_random`.
    /// Vectors computed with an independent Python replica; both
    /// `speed_tie_breaker` parities are represented.
    #[test]
    fn from_ctx_random_known_answer_vectors() {
        let expect = [
            (0u32, (100u8, 89u8, 15u8, 20u8, true)),
            (1, (86, 92, 70, 51, true)),
            (0x1234_5678, (100, 92, 7, 85, false)),
            (u32::MAX, (85, 89, 19, 34, false)),
        ];
        for (seed, want) in expect {
            let v = TurnVariance::from_ctx_random(seed);
            assert_eq!(
                (
                    v.damage_roll_a,
                    v.damage_roll_b,
                    v.accuracy_roll_a,
                    v.accuracy_roll_b,
                    v.speed_tie_breaker
                ),
                want,
                "seed {seed:#x}"
            );
        }
    }
}
