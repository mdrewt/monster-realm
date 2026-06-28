//! Evolution and fusion transforms — pure, deterministic `MonsterInstance` constructors.
//!
//! `evolve` changes a monster's species while carrying all individuality verbatim
//! (no re-roll — ADR-0019). `derived_stats` is re-derived from the TARGET species'
//! base stats (not the source), and `current_hp` is clamped to the new derived HP
//! (cannot exceed the new max, but damage is preserved when the new max is higher).
//!
//! `fuse` produces an offspring `MonsterInstance` from two parents and an offspring
//! species. The offspring is always fresh (level 1, zero EVs, default bond, full HP,
//! no nickname). Per-stat IVs are `max(a.iv, b.iv)`; nature comes from the
//! higher-bond parent (tie → `a`); party_slot is the min of the parents' present
//! slots (or `None` if both are `None`).

use crate::content::Species;
use crate::monster::rules::{derive_stats, xp_for_level};
use crate::monster::types::{Bond, EVs, Level, MonsterInstance, StatKind};

/// Evolve `monster` into `to_species`.
///
/// Carries verbatim: `nickname`, `level`, `xp`, `ivs`, `nature`, `evs`, `bond`,
/// `party_slot`. Re-derives `derived_stats` from `to_species.base_stats` (not the
/// source species' base stats). Clamps `current_hp` to `new_derived.hp` — damage
/// is preserved when the new max is higher, but current HP can never exceed the new
/// max HP.
///
/// No re-roll of IVs, nature, or EVs (ADR-0019 carry rule).
#[must_use]
pub fn evolve(monster: &MonsterInstance, to_species: &Species) -> MonsterInstance {
    todo!()
}

/// Fuse two parent monsters into a new offspring of `offspring` species.
///
/// Offspring properties:
/// - `species_id` = `offspring.id`
/// - `ivs`: per-stat `max(a.iv, b.iv)` for each of the six stats
/// - `nature`: higher-bond parent's nature (tie → `a`'s nature)
/// - `bond`: `Bond::default_bond()` (70)
/// - `party_slot`: min of present (Some) slots; `None` if both parents have `None`
/// - `level`: 1
/// - `evs`: `EVs::zero()`
/// - `nickname`: `None`
/// - `current_hp`: derived HP at level 1 (full)
/// - `xp`: `xp_for_level(Level::new(1).unwrap())`
/// - `derived_stats`: `derive_stats(offspring.base_stats, offspring_ivs, zero_evs, nature, L1)`
#[must_use]
pub fn fuse(a: &MonsterInstance, b: &MonsterInstance, offspring: &Species) -> MonsterInstance {
    todo!()
}

// ============================================================================
// Transform unit and boundary tests (M10a-rules, criteria 8–16)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Species;
    use crate::monster::rules::{derive_stats, level_for_xp, xp_for_level};
    use crate::monster::types::{
        Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, StatKind,
        Xp,
    };

    // -----------------------------------------------------------------------
    // Fixture helpers
    // -----------------------------------------------------------------------

    fn stat_block(hp: u16, other: u16) -> StatBlock {
        StatBlock {
            hp,
            attack: other,
            defense: other,
            speed: other,
            sp_attack: other,
            sp_defense: other,
        }
    }

    fn species(id: u32, hp: u16, other: u16) -> Species {
        Species {
            id,
            name: format!("Species{id}"),
            base_stats: stat_block(hp, other),
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![],
        }
    }

    /// Build a fully specified `MonsterInstance` for evolve tests (Criterion 8).
    /// Uses DISTINCTIVE non-default values for every carried field.
    fn distinctive_monster(source_species: &Species) -> MonsterInstance {
        let ivs = IVs::new(10, 15, 20, 25, 5, 31).unwrap();
        let nature = Nature::new(NatureKind::Adamant);
        let evs = EVs::new(100, 50, 0, 0, 0, 0).unwrap();
        let bond = Bond::new(180);
        let level = Level::new(30).unwrap();
        let derived_stats = derive_stats(&source_species.base_stats, &ivs, &evs, &nature, level);
        MonsterInstance {
            species_id: source_species.id,
            nickname: Some("Ember".to_string()),
            level,
            xp: Xp::new(999),
            ivs,
            nature,
            evs,
            bond,
            // Set current_hp to derived HP (full), will be used in clamp tests
            current_hp: derived_stats.hp,
            derived_stats,
            party_slot: Some(2),
        }
    }

    // -----------------------------------------------------------------------
    // Criterion 8 — CARRIES all individuality; re-derives from TARGET base stats
    // kills: re-roll, carrying old derived_stats, dropping any carried field
    // -----------------------------------------------------------------------

    /// Criterion 8: evolve carries all individuality verbatim; re-derives from target.
    /// DISTINCTIVE monster (non-default values for every carried field).
    #[test]
    fn evolve_carries_all_individuality_and_rederives_from_target() {
        // kills: re-roll, carrying old derived_stats, dropping any carried field
        let source_sp = species(1, 45, 49);
        let target_sp = species(2, 80, 100); // different base stats

        let monster = distinctive_monster(&source_sp);
        let result = evolve(&monster, &target_sp);

        // species_id changes to the target
        assert_eq!(result.species_id, target_sp.id, "species_id must be target");

        // ALL individuality fields carried verbatim
        assert_eq!(
            result.nickname, monster.nickname,
            "nickname must be carried"
        );
        assert_eq!(
            result.level.as_u8(),
            monster.level.as_u8(),
            "level must be carried"
        );
        assert_eq!(result.xp, monster.xp, "xp must be carried");
        assert_eq!(result.ivs, monster.ivs, "ivs must be carried (no re-roll)");
        assert_eq!(result.nature, monster.nature, "nature must be carried");
        assert_eq!(result.evs, monster.evs, "evs must be carried");
        assert_eq!(result.bond, monster.bond, "bond must be carried");
        assert_eq!(
            result.party_slot, monster.party_slot,
            "party_slot must be carried"
        );

        // derived_stats re-derived from TARGET base stats (not source)
        let expected_derived = derive_stats(
            &target_sp.base_stats,
            &monster.ivs,
            &monster.evs,
            &monster.nature,
            monster.level,
        );
        assert_eq!(
            result.derived_stats, expected_derived,
            "derived_stats must be re-derived from TARGET base stats"
        );

        // current_hp is clamped (monster was at full HP; target HP >= clamped value)
        assert!(
            result.current_hp <= result.derived_stats.hp,
            "current_hp must not exceed new derived HP"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 9 — CLAMP fires (evolving DOWN in HP)
    // kills: "keep old current_hp unchanged" / forget-to-clamp
    // -----------------------------------------------------------------------

    /// Criterion 9: evolving to a lower-HP species clamps current_hp DOWN.
    /// Source has base HP=200, target base HP=20. Monster at full HP.
    /// After evolve: current_hp must equal the NEW (lower) derived HP.
    #[test]
    fn evolve_clamps_current_hp_when_target_hp_is_lower() {
        // kills: an impl that keeps old current_hp when the new max is lower
        let source_sp = species(1, 200, 80); // very high HP base
        let target_sp = species(2, 20, 80); // very low HP base

        let ivs = IVs::new(0, 0, 0, 0, 0, 0).unwrap();
        let nature = Nature::new(NatureKind::Hardy);
        let evs = EVs::zero();
        let level = Level::new(30).unwrap();

        let source_derived = derive_stats(&source_sp.base_stats, &ivs, &evs, &nature, level);
        let target_derived = derive_stats(&target_sp.base_stats, &ivs, &evs, &nature, level);

        // Verify the fixture is non-vacuous: source HP > target HP
        assert!(
            source_derived.hp > target_derived.hp,
            "fixture sanity: source HP ({}) must be > target HP ({}) for clamp to fire",
            source_derived.hp,
            target_derived.hp
        );

        let monster = MonsterInstance {
            species_id: source_sp.id,
            nickname: None,
            level,
            xp: xp_for_level(level),
            ivs,
            nature,
            evs,
            bond: Bond::default_bond(),
            current_hp: source_derived.hp, // at FULL HP
            derived_stats: source_derived,
            party_slot: None,
        };

        let result = evolve(&monster, &target_sp);

        // CLAMP: current_hp must be the new (lower) derived HP, not the old (higher) value
        assert_eq!(
            result.current_hp, target_derived.hp,
            "current_hp must be clamped DOWN to new derived HP ({}) — \
             old current_hp was {} which exceeds the new max",
            target_derived.hp, source_derived.hp
        );
        // Verify the clamp was strictly less than pre-evolve current_hp (non-vacuous)
        assert!(
            result.current_hp < monster.current_hp,
            "clamp must produce a strictly LOWER current_hp than before (got {} vs {})",
            result.current_hp,
            monster.current_hp
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 10 — DAMAGED monster evolving UP is NOT healed
    // kills: "always set current_hp = full new max"
    // -----------------------------------------------------------------------

    /// Criterion 10: a damaged monster evolving to a higher-HP species keeps its damage.
    /// current_hp is carried as-is (not healed to full new max).
    #[test]
    fn evolve_does_not_heal_damaged_monster_when_evolving_up() {
        // kills: an impl that sets current_hp = new derived HP unconditionally
        let source_sp = species(1, 45, 49); // modest HP
        let target_sp = species(2, 120, 49); // higher HP

        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let nature = Nature::new(NatureKind::Hardy);
        let evs = EVs::zero();
        let level = Level::new(30).unwrap();

        let source_derived = derive_stats(&source_sp.base_stats, &ivs, &evs, &nature, level);
        let target_derived = derive_stats(&target_sp.base_stats, &ivs, &evs, &nature, level);

        // Verify fixture: target HP must be higher than source HP
        assert!(
            target_derived.hp > source_derived.hp,
            "fixture sanity: target HP must be > source HP for 'heal' test"
        );

        // Monster is DAMAGED: current_hp well below max
        let damaged_hp = source_derived.hp / 4; // at 25% HP — clearly damaged
        assert!(
            damaged_hp < source_derived.hp,
            "fixture sanity: damaged_hp must be below full HP"
        );

        let monster = MonsterInstance {
            species_id: source_sp.id,
            nickname: None,
            level,
            xp: xp_for_level(level),
            ivs,
            nature,
            evs,
            bond: Bond::default_bond(),
            current_hp: damaged_hp,
            derived_stats: source_derived,
            party_slot: None,
        };

        let result = evolve(&monster, &target_sp);

        // Damage is preserved: current_hp == pre-evolve current_hp (not healed to full)
        assert_eq!(
            result.current_hp, damaged_hp,
            "current_hp must equal pre-evolve damaged HP ({}) — \
             must NOT be healed to new max ({})",
            damaged_hp, target_derived.hp
        );
        // Non-vacuity: current_hp is strictly less than the new max
        assert!(
            result.current_hp < result.derived_stats.hp,
            "current_hp ({}) must be strictly less than new max HP ({})",
            result.current_hp,
            result.derived_stats.hp
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 11 — Fuse: IV per-stat MAX
    // kills: min/avg/parent-a-only/field-transposition
    // -----------------------------------------------------------------------

    /// Criterion 11: offspring IVs = max(a.iv, b.iv) per stat with COMPLEMENTARY parents.
    /// a=(10,31,5,20,0,15), b=(31,5,20,0,15,10) => offspring=(31,31,20,20,15,15).
    #[test]
    fn fuse_ivs_are_per_stat_max_of_parents() {
        // kills: min(a,b) / avg / always parent-a / any field transposition
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);

        let a_ivs = IVs::new(10, 31, 5, 20, 0, 15).unwrap();
        let b_ivs = IVs::new(31, 5, 20, 0, 15, 10).unwrap();

        let base = StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let nat = Nature::new(NatureKind::Hardy);
        let evs = EVs::zero();
        let lv5 = Level::new(5).unwrap();

        let a_derived = derive_stats(&base, &a_ivs, &evs, &nat, lv5);
        let b_derived = derive_stats(&base, &b_ivs, &evs, &nat, lv5);

        let a = MonsterInstance {
            species_id: sp_a.id,
            nickname: Some("Alpha".to_string()),
            level: lv5,
            xp: xp_for_level(lv5),
            ivs: a_ivs,
            nature: nat,
            evs,
            bond: Bond::new(100),
            current_hp: a_derived.hp,
            derived_stats: a_derived,
            party_slot: Some(1),
        };
        let b = MonsterInstance {
            species_id: sp_b.id,
            nickname: Some("Beta".to_string()),
            level: lv5,
            xp: xp_for_level(lv5),
            ivs: b_ivs,
            nature: nat,
            evs,
            bond: Bond::new(200),
            current_hp: b_derived.hp,
            derived_stats: b_derived,
            party_slot: Some(2),
        };

        let offspring = fuse(&a, &b, &sp_off);

        // Expected IVs: max per stat
        // Hp: max(10,31)=31, Atk: max(31,5)=31, Def: max(5,20)=20
        // Spd: max(20,0)=20, SpA: max(0,15)=15, SpD: max(15,10)=15
        assert_eq!(
            offspring.ivs.get(StatKind::Hp),
            31,
            "HP IV: max(10,31) must be 31 (kills min/avg/parent-a)"
        );
        assert_eq!(
            offspring.ivs.get(StatKind::Attack),
            31,
            "Atk IV: max(31,5) must be 31 (kills parent-b-only / field swap)"
        );
        assert_eq!(
            offspring.ivs.get(StatKind::Defense),
            20,
            "Def IV: max(5,20) must be 20 (kills parent-a-only)"
        );
        assert_eq!(
            offspring.ivs.get(StatKind::Speed),
            20,
            "Spd IV: max(20,0) must be 20"
        );
        assert_eq!(
            offspring.ivs.get(StatKind::SpAttack),
            15,
            "SpA IV: max(0,15) must be 15"
        );
        assert_eq!(
            offspring.ivs.get(StatKind::SpDefense),
            15,
            "SpD IV: max(15,10) must be 15 (kills field transposition)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 12 — Fuse: nature = higher-bond parent's
    // kills: picking lower-bond / always-a
    // -----------------------------------------------------------------------

    /// Criterion 12a: a.bond=100, b.bond=200, different natures → offspring nature == b's.
    #[test]
    fn fuse_nature_is_higher_bond_parents() {
        // kills: always-a / picking lower-bond
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);

        let nat_a = Nature::new(NatureKind::Adamant);
        let nat_b = Nature::new(NatureKind::Timid);
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let evs = EVs::zero();
        let lv5 = Level::new(5).unwrap();

        let make_mon = |species_id: u32, nat: Nature, bond_val: u8| {
            let base = StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            };
            let ds = derive_stats(&base, &ivs, &evs, &nat, lv5);
            MonsterInstance {
                species_id,
                nickname: None,
                level: lv5,
                xp: xp_for_level(lv5),
                ivs,
                nature: nat,
                evs,
                bond: Bond::new(bond_val),
                current_hp: ds.hp,
                derived_stats: ds,
                party_slot: None,
            }
        };

        let a = make_mon(sp_a.id, nat_a, 100);
        let b = make_mon(sp_b.id, nat_b, 200);

        let offspring = fuse(&a, &b, &sp_off);

        assert_eq!(
            offspring.nature, nat_b,
            "b has higher bond (200 > 100) — offspring nature must be b's (Timid)"
        );
    }

    /// Criterion 12b (swapped bonds): a.bond=200, b.bond=100 → offspring nature == a's.
    #[test]
    fn fuse_nature_higher_bond_parent_a_wins_when_a_has_higher_bond() {
        // kills: always-b
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);

        let nat_a = Nature::new(NatureKind::Adamant);
        let nat_b = Nature::new(NatureKind::Timid);
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let evs = EVs::zero();
        let lv5 = Level::new(5).unwrap();

        let make_mon = |species_id: u32, nat: Nature, bond_val: u8| {
            let base = StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            };
            let ds = derive_stats(&base, &ivs, &evs, &nat, lv5);
            MonsterInstance {
                species_id,
                nickname: None,
                level: lv5,
                xp: xp_for_level(lv5),
                ivs,
                nature: nat,
                evs,
                bond: Bond::new(bond_val),
                current_hp: ds.hp,
                derived_stats: ds,
                party_slot: None,
            }
        };

        let a = make_mon(sp_a.id, nat_a, 200); // a has higher bond
        let b = make_mon(sp_b.id, nat_b, 100);

        let offspring = fuse(&a, &b, &sp_off);

        assert_eq!(
            offspring.nature, nat_a,
            "a has higher bond (200 > 100) — offspring nature must be a's (Adamant)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 13 — Fuse: nature tie (equal bond) → a's nature
    // kills: `>` making tie go to b / b-wins-on-tie
    // -----------------------------------------------------------------------

    /// Criterion 13: a.bond == b.bond, different natures → offspring nature == a's.
    #[test]
    fn fuse_nature_tie_uses_a_nature() {
        // kills: `b.bond > a.bond` (strict) making tie go to b, returning b's nature
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);

        let nat_a = Nature::new(NatureKind::Adamant);
        let nat_b = Nature::new(NatureKind::Timid);
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let evs = EVs::zero();
        let lv5 = Level::new(5).unwrap();

        let make_mon = |species_id: u32, nat: Nature, bond_val: u8| {
            let base = StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            };
            let ds = derive_stats(&base, &ivs, &evs, &nat, lv5);
            MonsterInstance {
                species_id,
                nickname: None,
                level: lv5,
                xp: xp_for_level(lv5),
                ivs,
                nature: nat,
                evs,
                bond: Bond::new(bond_val),
                current_hp: ds.hp,
                derived_stats: ds,
                party_slot: None,
            }
        };

        let a = make_mon(sp_a.id, nat_a, 150); // EQUAL bond
        let b = make_mon(sp_b.id, nat_b, 150); // EQUAL bond

        let offspring = fuse(&a, &b, &sp_off);

        assert_eq!(
            offspring.nature, nat_a,
            "equal bond TIE must produce a's nature (Adamant), not b's (Timid)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 14 — Fuse: party_slot min of present slots
    // kills: Option::min (None<Some), `.or()` take-first, max
    // -----------------------------------------------------------------------

    fn make_fuse_pair(
        sp_a: &Species,
        sp_b: &Species,
        slot_a: Option<u8>,
        slot_b: Option<u8>,
    ) -> (MonsterInstance, MonsterInstance) {
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let evs = EVs::zero();
        let nat = Nature::new(NatureKind::Hardy);
        let lv5 = Level::new(5).unwrap();
        let base = StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let ds = derive_stats(&base, &ivs, &evs, &nat, lv5);

        let a = MonsterInstance {
            species_id: sp_a.id,
            nickname: None,
            level: lv5,
            xp: xp_for_level(lv5),
            ivs,
            nature: nat,
            evs,
            bond: Bond::new(100),
            current_hp: ds.hp,
            derived_stats: ds,
            party_slot: slot_a,
        };
        let b = MonsterInstance {
            species_id: sp_b.id,
            nickname: None,
            level: lv5,
            xp: xp_for_level(lv5),
            ivs,
            nature: nat,
            evs,
            bond: Bond::new(100),
            current_hp: ds.hp,
            derived_stats: ds,
            party_slot: slot_b,
        };
        (a, b)
    }

    /// Criterion 14a: (Some(7), Some(3)) → Some(3) (min of both present).
    #[test]
    fn fuse_party_slot_min_of_both_present() {
        // kills: max / takes first / Option::min (None sorts as smallest)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, Some(7), Some(3));
        assert_eq!(
            fuse(&a, &b, &sp_off).party_slot,
            Some(3),
            "(Some(7), Some(3)) must yield Some(3)"
        );
    }

    /// Criterion 14b: (Some(3), Some(7)) → Some(3) (order-independent min).
    #[test]
    fn fuse_party_slot_min_order_independent() {
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, Some(3), Some(7));
        assert_eq!(
            fuse(&a, &b, &sp_off).party_slot,
            Some(3),
            "(Some(3), Some(7)) must yield Some(3)"
        );
    }

    /// Criterion 14c: (Some(5), None) → Some(5) (only a present).
    #[test]
    fn fuse_party_slot_a_present_b_none() {
        // kills: `.or()` take-first (correct but need None+Some(5) also covered)
        // kills: raw Option::min (None < Some(0) in std ordering → would pick None)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, Some(5), None);
        assert_eq!(
            fuse(&a, &b, &sp_off).party_slot,
            Some(5),
            "(Some(5), None) must yield Some(5) — not None"
        );
    }

    /// Criterion 14d: (None, Some(5)) → Some(5) (only b present).
    #[test]
    fn fuse_party_slot_a_none_b_present() {
        // kills: always-a-first (`.map(|_| a.party_slot).or(b.party_slot)`)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, None, Some(5));
        assert_eq!(
            fuse(&a, &b, &sp_off).party_slot,
            Some(5),
            "(None, Some(5)) must yield Some(5) — not None"
        );
    }

    /// Criterion 14e: (None, None) → None.
    #[test]
    fn fuse_party_slot_both_none_yields_none() {
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, None, None);
        assert_eq!(
            fuse(&a, &b, &sp_off).party_slot,
            None,
            "(None, None) must yield None"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 15 — Fuse: fresh body (level 1, zero evs, no nickname, full HP, etc.)
    // kills: carrying evs/nickname/level/xp/bond; kills current_hp not full
    // -----------------------------------------------------------------------

    /// Criterion 15: distinctive parents → offspring is a fresh level-1 body.
    #[test]
    fn fuse_produces_fresh_body() {
        // kills: carrying parent evs / nickname / level / xp / bond
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 80, 100);
        let sp_off = species(5, 60, 70);

        let a_ivs = IVs::new(31, 31, 31, 31, 31, 31).unwrap();
        let b_ivs = IVs::new(0, 0, 0, 0, 0, 0).unwrap();
        let a_evs = EVs::new(252, 252, 6, 0, 0, 0).unwrap();
        let b_evs = EVs::new(0, 0, 0, 0, 0, 0).unwrap();
        let nat_a = Nature::new(NatureKind::Adamant);
        let nat_b = Nature::new(NatureKind::Timid);
        let lv50 = Level::new(50).unwrap();

        let base_a = StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let base_b = StatBlock {
            hp: 80,
            attack: 100,
            defense: 100,
            speed: 80,
            sp_attack: 80,
            sp_defense: 80,
        };

        let ds_a = derive_stats(&base_a, &a_ivs, &a_evs, &nat_a, lv50);
        let ds_b = derive_stats(&base_b, &b_ivs, &b_evs, &nat_b, lv50);

        let a = MonsterInstance {
            species_id: sp_a.id,
            nickname: Some("ParentA".to_string()),
            level: lv50,
            xp: xp_for_level(lv50),
            ivs: a_ivs,
            nature: nat_a,
            evs: a_evs,
            bond: Bond::new(200),
            current_hp: ds_a.hp,
            derived_stats: ds_a,
            party_slot: Some(0),
        };
        let b = MonsterInstance {
            species_id: sp_b.id,
            nickname: Some("ParentB".to_string()),
            level: lv50,
            xp: xp_for_level(lv50),
            ivs: b_ivs,
            nature: nat_b,
            evs: b_evs,
            bond: Bond::new(100),
            current_hp: ds_b.hp,
            derived_stats: ds_b,
            party_slot: Some(3),
        };

        let offspring = fuse(&a, &b, &sp_off);

        // Fresh body checks
        assert_eq!(
            offspring.species_id, sp_off.id,
            "species_id must be offspring.id"
        );
        assert_eq!(offspring.level.as_u8(), 1, "level must be 1");
        assert_eq!(offspring.evs.total(), 0, "evs must be zero");
        assert_eq!(offspring.nickname, None, "nickname must be None");
        assert_eq!(
            offspring.bond,
            Bond::default_bond(),
            "bond must be default_bond() (70)"
        );
        // current_hp must equal derived HP (full, > 0)
        assert_eq!(
            offspring.current_hp, offspring.derived_stats.hp,
            "current_hp must equal derived HP (full)"
        );
        assert!(
            offspring.current_hp > 0,
            "current_hp must be > 0 (derived HP at level 1 is always positive)"
        );
        // xp must equal xp_for_level(L1)
        let l1 = Level::new(1).unwrap();
        assert_eq!(
            offspring.xp,
            xp_for_level(l1),
            "xp must equal xp_for_level(L1)"
        );
        // derived_stats is the SSOT: derive_stats(offspring base, offspring ivs, zero evs, offspring nature, L1)
        // kills: derived_stats computed from wrong base/nature/evs inputs
        // (e.g. using a parent's base stats, a parent's EVs, or the wrong nature into derive_stats)
        let expected_derived = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &EVs::zero(),
            &offspring.nature,
            l1,
        );
        assert_eq!(
            offspring.derived_stats, expected_derived,
            "derived_stats must equal derive_stats(offspring.base_stats, offspring.ivs, EVs::zero(), offspring.nature, L1)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 16 — xp consistent with level 1
    // kills: hardcoded mismatched xp (e.g. xp=0 while level=1 requires xp=1)
    // -----------------------------------------------------------------------

    /// Criterion 16: level_for_xp(offspring.xp).as_u8() == 1.
    #[test]
    fn fuse_xp_is_consistent_with_level_1() {
        // kills: xp=0 (which maps to level 1 but is below xp_for_level(1)=1 → level_for_xp gives 1, actually ok)
        // The real contract: xp == xp_for_level(L1) == 1^3 == 1, and level_for_xp(1)==1
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let (a, b) = make_fuse_pair(&sp_a, &sp_b, None, None);

        let offspring = fuse(&a, &b, &sp_off);

        assert_eq!(
            level_for_xp(offspring.xp).as_u8(),
            1,
            "level_for_xp(offspring.xp) must be 1 — xp must be xp_for_level(L1)"
        );

        // Pin exact value: xp_for_level(L1) = 1^3 = 1
        let l1 = Level::new(1).unwrap();
        assert_eq!(
            offspring.xp,
            xp_for_level(l1),
            "xp must equal xp_for_level(L1) = 1"
        );
    }
}
