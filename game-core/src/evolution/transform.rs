//! Evolution transforms — pure, deterministic `MonsterInstance` constructors.
//!
//! `evolve` changes a monster's species while carrying all individuality verbatim
//! (no re-roll — ADR-0019). `derived_stats` is re-derived from the TARGET species'
//! base stats (not the source), and `current_hp` is clamped to the new derived HP
//! (cannot exceed the new max, but damage is preserved when the new max is higher).
//!
//! Per ADR-0174 D2 it ALSO zeroes all 8 essence pools — essence is SPENT by an
//! evolution (spec §4 "Full essence reset on evolution", confirmed). Trust and
//! Quality-Time are lifetime history and are carried verbatim, never reset.
//!
//! `fuse` and the ADR-0147 taxed-carry math (`FUSION_EFFICIENCY`,
//! `LEVEL_RETENTION_FLOOR`, `scale_u32`, `avg_u32`) are DELETED — fusion is
//! removed as a feature (EG1-9), not repurposed.

use crate::content::Species;
use crate::monster::rules::derive_stats;
use crate::monster::types::MonsterInstance;

/// Evolve `monster` into `to_species`.
///
/// Carries verbatim: `nickname`, `level`, `xp`, `ivs`, `nature`, `evs`,
/// `party_slot`, and the three lifetime history stats
/// (`trust_favorable_count`, `trust_unfavorable_count`,
/// `quality_time_ticks_total`). Re-derives `derived_stats` from
/// `to_species.base_stats` (not the source species' base stats). Clamps
/// `current_hp` to `new_derived.hp` — damage is preserved when the new max is
/// higher, but current HP can never exceed the new max HP. Zeroes all 8
/// essence pools (ADR-0174 D2).
///
/// No re-roll of IVs, nature, or EVs (ADR-0019 carry rule).
#[must_use]
pub fn evolve(monster: &MonsterInstance, to_species: &Species) -> MonsterInstance {
    // Re-derive from the TARGET base stats via the SSOT, carrying the monster's
    // individuality (no re-roll — ADR-0019).
    let derived = derive_stats(
        &to_species.base_stats,
        &monster.ivs,
        &monster.evs,
        &monster.nature,
        monster.level,
    );
    // Clone carries every other field (nickname/level/xp/ivs/nature/evs/
    // party_slot + the history stats) verbatim; only species, stats, and
    // clamped HP change.
    let mut out = monster.clone();
    out.species_id = to_species.id;
    out.derived_stats = derived;
    // Transformation, not a heal: preserve damage but never exceed the new max.
    out.current_hp = monster.current_hp.min(derived.hp);
    // Essence is SPENT by an evolution (ADR-0174 D2): ALL 8 pools reset, so the
    // next tier's bar is climbed from zero. Trust/Quality-Time stay untouched —
    // the clone above carries the lifetime history verbatim.
    out.essence = [0; 8];
    out
}

// ============================================================================
// Transform unit and boundary tests (M10a-rules, criteria 8-10)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Species;
    use crate::monster::rules::{derive_stats, xp_for_level};
    use crate::monster::types::{
        Affinity, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, Xp,
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
            ability: None,
            tier: 0,
        }
    }

    /// Build a fully specified `MonsterInstance` for evolve tests (Criterion 8).
    /// Uses DISTINCTIVE non-default values for every carried field.
    fn distinctive_monster(source_species: &Species) -> MonsterInstance {
        let ivs = IVs::new(10, 15, 20, 25, 5, 31).unwrap();
        let nature = Nature::new(NatureKind::Adamant);
        let evs = EVs::new(100, 50, 0, 0, 0, 0).unwrap();
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
            essence: [11, 22, 33, 44, 55, 66, 77, 88],
            trust_favorable_count: 17,
            trust_unfavorable_count: 3,
            quality_time_ticks_total: 240,
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
            essence: [0; 8],
            trust_favorable_count: 0,
            trust_unfavorable_count: 0,
            quality_time_ticks_total: 0,
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
            essence: [0; 8],
            trust_favorable_count: 0,
            trust_unfavorable_count: 0,
            quality_time_ticks_total: 0,
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
}
