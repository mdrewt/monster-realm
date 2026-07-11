//! Seeded RNG-based construction of monster individuality and starter monsters.
//! Deterministic: same seed always produces the same result (ADR-0003).
//! Never reads a wall-clock or system RNG — seed is injected by the caller.

use super::types::{IVs, MonsterInstance, Nature};
use crate::content::Species;

use super::types::{Bond, EVs, Level, StatKind};
use crate::monster::rules::{derive_stats, xp_for_level};

/// Splitmix32-style mixing function (follows the `tick_seed` pattern in lib.rs).
fn splitmix32(state: &mut u32) -> u32 {
    *state = state.wrapping_add(0x9E37_79B9);
    let mut z = *state;
    z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
    z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
    z ^ (z >> 16)
}

/// Roll individual values and nature from a deterministic seed.
/// Same seed always produces the same (IVs, Nature).
#[must_use]
pub fn roll_individuality(seed: u32) -> (IVs, Nature) {
    let mut state = seed;
    let hp = (splitmix32(&mut state) % 32) as u8;
    let attack = (splitmix32(&mut state) % 32) as u8;
    let defense = (splitmix32(&mut state) % 32) as u8;
    let speed = (splitmix32(&mut state) % 32) as u8;
    let sp_attack = (splitmix32(&mut state) % 32) as u8;
    let sp_defense = (splitmix32(&mut state) % 32) as u8;
    let nature_idx = (splitmix32(&mut state) % 25) as u8;

    let ivs = IVs::new(hp, attack, defense, speed, sp_attack, sp_defense)
        .expect("splitmix32 % 32 always produces [0, 31]");
    let nature = Nature::from_index(nature_idx);
    (ivs, nature)
}

/// Build a monster at an arbitrary `level` from a seed and species definition.
///
/// The level-parameterized generalization of [`roll_starter`]: IVs+nature come
/// from [`roll_individuality`] (so the SAME seed always rebuilds the SAME
/// individual — the M8d "recruit THAT exact wild" trust invariant), EVs are
/// zero, bond is the species default (70), `current_hp` equals the derived HP
/// (full HP on grant), and `xp` is `xp_for_level(level)` (the start of the
/// target level band, not 0).
#[must_use]
pub fn build_monster(seed: u32, species: &Species, level: Level) -> MonsterInstance {
    let (ivs, nature) = roll_individuality(seed);
    let evs = EVs::zero();
    let derived_stats = derive_stats(&species.base_stats, &ivs, &evs, &nature, level);
    let current_hp = derived_stats.get(StatKind::Hp);

    MonsterInstance {
        species_id: species.id,
        nickname: None,
        level,
        xp: xp_for_level(level),
        ivs,
        nature,
        evs,
        bond: Bond::default_bond(),
        current_hp,
        derived_stats,
        party_slot: None,
    }
}

/// Create a level-5 starter monster from a seed and species definition.
/// EVs are zero, bond is default (70), current_hp equals derived HP.
///
/// Thin wrapper over [`build_monster`] at the fixed starter level (5) — kept as
/// a distinct entry point so M7 callers and their tests read intentionally.
#[must_use]
pub fn roll_starter(seed: u32, species: &Species) -> MonsterInstance {
    build_monster(seed, species, Level::new(5).expect("5 is a valid level"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::types::{Affinity, StatBlock, StatKind};
    use proptest::prelude::*;

    /// A fixture species for testing — enough to drive roll_starter.
    fn test_species() -> Species {
        Species {
            id: 1,
            name: "Flameling".to_string(),
            base_stats: StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            },
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1, 2],
            ability: None,
        }
    }

    // =======================================================================
    // Example-based tests
    // =======================================================================

    /// #46: roll_individuality is deterministic — same seed, same result.
    /// Kills: an impl that uses system RNG or non-deterministic hashing.
    #[test]
    fn roll_individuality_is_deterministic() {
        let (ivs_a, nat_a) = roll_individuality(42);
        let (ivs_b, nat_b) = roll_individuality(42);
        assert_eq!(ivs_a, ivs_b);
        assert_eq!(nat_a, nat_b);
    }

    /// #47: Different seeds produce different results.
    /// Kills: an impl that ignores the seed.
    #[test]
    fn roll_individuality_different_seeds_differ() {
        let (ivs_0, nat_0) = roll_individuality(0);
        let (ivs_1, nat_1) = roll_individuality(1);
        // At least one of IVs or Nature should differ
        assert!(
            ivs_0 != ivs_1 || nat_0 != nat_1,
            "seed 0 and seed 1 should produce different individuality"
        );
    }

    /// #48: roll_starter creates a level 5 monster.
    /// Kills: an impl that uses a different starter level.
    #[test]
    fn roll_starter_creates_level_5() {
        let m = roll_starter(0, &test_species());
        assert_eq!(m.level.as_u8(), 5);
    }

    /// #49: roll_starter creates a monster with zero EVs.
    /// Kills: an impl that gives starters non-zero EVs.
    #[test]
    fn roll_starter_has_zero_evs() {
        let m = roll_starter(0, &test_species());
        assert_eq!(m.evs, EVs::zero());
    }

    /// #50: roll_starter creates a monster with default bond (70).
    /// Kills: an impl that uses a different default bond.
    #[test]
    fn roll_starter_has_default_bond() {
        let m = roll_starter(0, &test_species());
        assert_eq!(m.bond, Bond::default_bond());
    }

    /// #51: roll_starter creates a monster whose current_hp equals its derived HP.
    /// Kills: an impl that forgets to initialize current_hp.
    #[test]
    fn roll_starter_has_full_hp() {
        let m = roll_starter(0, &test_species());
        assert_eq!(m.current_hp, m.derived_stats.get(StatKind::Hp));
    }

    /// #52: roll_starter's derived_stats field matches calling derive_stats directly.
    /// Kills: an impl that computes derived_stats with wrong inputs.
    #[test]
    fn roll_starter_derived_matches_derive_stats() {
        let sp = test_species();
        let m = roll_starter(99, &sp);
        let expected = derive_stats(&sp.base_stats, &m.ivs, &m.evs, &m.nature, m.level);
        assert_eq!(m.derived_stats, expected);
    }

    // =======================================================================
    // Property-based tests
    // =======================================================================

    proptest! {
        /// #53: For all u32 seeds, rolled IVs are in [0,31] and Nature is valid.
        /// Kills: an impl that produces out-of-range IVs.
        #[test]
        fn roll_individuality_valid_for_all_seeds(seed in any::<u32>()) {
            let (ivs, _nature) = roll_individuality(seed);
            let all_stats = [
                StatKind::Hp,
                StatKind::Attack,
                StatKind::Defense,
                StatKind::Speed,
                StatKind::SpAttack,
                StatKind::SpDefense,
            ];
            for kind in all_stats {
                prop_assert!(ivs.get(kind) <= 31, "IV for {kind:?} exceeds 31");
            }
        }

        /// #54: For all u32 seeds, roll_starter produces a valid MonsterInstance.
        /// Kills: an impl that can produce invalid state for certain seeds.
        #[test]
        fn roll_starter_valid_for_all_seeds(seed in any::<u32>()) {
            let sp = test_species();
            let m = roll_starter(seed, &sp);
            prop_assert_eq!(m.level.as_u8(), 5);
            prop_assert_eq!(m.evs, EVs::zero());
            prop_assert_eq!(m.bond, Bond::default_bond());
            prop_assert_eq!(m.current_hp, m.derived_stats.get(StatKind::Hp));
            prop_assert_eq!(m.species_id, sp.id);
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: known-answer vectors pin the exact
    // splitmix32 mixing chain (ADR-0003 seed-stability: the SAME seed must
    // rebuild the SAME individual forever — saved-monster compatibility).
    // -----------------------------------------------------------------------

    /// Kills: all bit-mixing mutants inside `splitmix32` (9 survivors).
    /// Vectors computed with an independent Python replica.
    #[test]
    fn splitmix32_known_answer_sequence() {
        let mut s: u32 = 0;
        assert_eq!(splitmix32(&mut s), 0x92CA_2F0E);
        assert_eq!(
            s, 0x9E37_79B9,
            "state advances by the golden-ratio constant"
        );
        assert_eq!(splitmix32(&mut s), 0x3CD6_E3F3);
        assert_eq!(splitmix32(&mut s), 0x1B14_7DCC);

        let mut s2: u32 = 0xDEAD_BEEF;
        assert_eq!(splitmix32(&mut s2), 0xD3CE_9097);
        assert_eq!(splitmix32(&mut s2), 0x6211_7CED);
        assert_eq!(splitmix32(&mut s2), 0xF2C8_0841);
    }

    /// Kills: the `% 32` -> `/`/`+` mutants in `roll_individuality` (2
    /// survivors) plus any draw-order regression. Exact (IVs, Nature) per seed.
    #[test]
    fn roll_individuality_known_answer_vectors() {
        use crate::monster::types::Nature;
        let expect: [(u32, [u8; 6], u8); 3] = [
            (0, [14, 19, 12, 31, 11, 29], 18),
            (1, [11, 16, 4, 7, 24, 9], 19),
            (0xCAFE_BABE, [7, 19, 14, 19, 10, 29], 22),
        ];
        for (seed, iv, nature_idx) in expect {
            let (ivs, nature) = roll_individuality(seed);
            let want = IVs::new(iv[0], iv[1], iv[2], iv[3], iv[4], iv[5])
                .expect("expected IVs are all in [0, 31]");
            assert_eq!(ivs, want, "IVs for seed {seed:#x}");
            assert_eq!(
                nature,
                Nature::from_index(nature_idx),
                "nature for seed {seed:#x}"
            );
        }
    }
}
