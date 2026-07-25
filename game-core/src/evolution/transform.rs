//! Evolution and fusion transforms — pure, deterministic `MonsterInstance` constructors.
//!
//! `evolve` changes a monster's species while carrying all individuality verbatim
//! (no re-roll — ADR-0019). `derived_stats` is re-derived from the TARGET species'
//! base stats (not the source), and `current_hp` is clamped to the new derived HP
//! (cannot exceed the new max, but damage is preserved when the new max is higher).
//!
//! `fuse` produces an offspring `MonsterInstance` from two parents, an offspring
//! species, and an optional chosen nickname. The offspring carries TAXED
//! individuality (ADR-0147, repairing the ADR-0019 "carry/combine, not erase"
//! drift): bond = 75% of the max parent bond; level = the greater of 75% of the
//! parents' average level and 50% of the max parent level (never below 1); EVs =
//! 75% of the per-stat average; xp = `xp_for_level(level)`. Per-stat IVs are
//! `max(a.iv, b.iv)`; nature comes from the higher-bond parent (tie → `a`);
//! party_slot is the min of the parents' present slots (or `None` if both are
//! `None`); current_hp is full at the new derived stats.

use crate::content::Species;
use crate::monster::rules::{derive_stats, xp_for_level};
use crate::monster::types::{Bond, EVs, IVs, Level, MonsterInstance, StatKind};

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
    // Re-derive from the TARGET base stats via the SSOT, carrying the monster's
    // individuality (no re-roll — ADR-0019).
    let derived = derive_stats(
        &to_species.base_stats,
        &monster.ivs,
        &monster.evs,
        &monster.nature,
        monster.level,
    );
    // Clone carries every other field (nickname/level/xp/ivs/nature/evs/bond/
    // party_slot) verbatim; only species, stats, and clamped HP change.
    let mut out = monster.clone();
    out.species_id = to_species.id;
    out.derived_stats = derived;
    // Transformation, not a heal: preserve damage but never exceed the new max.
    out.current_hp = monster.current_hp.min(derived.hp);
    out
}

/// Percentage of the parents' combined investment (bond / averaged level / EVs)
/// that survives a fusion — the ADR-0147 fusion tax. `120 × 75% = 90 < 120`, so
/// a minimum-bond parent pair yields an offspring below `MIN_FUSION_BOND` (see
/// `eligibility.rs`) — the tax, not a lock, is what prevents a carrier loop.
pub const FUSION_EFFICIENCY: u32 = 75;

/// Floor on level carry: the offspring is never below this percentage of the
/// STRONGER parent's level, protecting a lopsided pair from a low taxed average
/// (ADR-0147).
pub const LEVEL_RETENTION_FLOOR: u32 = 50;

/// `v * pct / 100`, truncating toward zero. Domain: `v * pct` must fit in `u32`
/// (callers pass v <= 255 and pct <= 75 — far inside the safe range).
fn scale_u32(v: u32, pct: u32) -> u32 {
    v * pct / 100
}

/// Integer-floor average. Domain: `a + b` must fit in `u32` (callers pass
/// values <= 255).
fn avg_u32(a: u32, b: u32) -> u32 {
    (a + b) / 2
}

/// Fuse two parent monsters into a new offspring of `offspring` species,
/// carrying TAXED individuality (ADR-0147; repairs the ADR-0019 drift where
/// fusion hard-reset the relationship half of a monster's identity).
///
/// Offspring properties:
/// - `species_id` = `offspring.id`
/// - `ivs`: per-stat `max(a.iv, b.iv)` for each of the six stats (unchanged)
/// - `nature`: higher-bond parent's nature (tie → `a`'s nature) (unchanged)
/// - `bond`: `scale_u32(max(a.bond, b.bond), FUSION_EFFICIENCY)` — 75% of the
///   max parent bond, never `Bond::default_bond()`
/// - `level`: `max(scale_u32(avg(a.level, b.level), FUSION_EFFICIENCY),
///   scale_u32(max(a.level, b.level), LEVEL_RETENTION_FLOOR)).max(1)`
/// - `xp`: `xp_for_level(level)` — the level/xp pair invariant
///   `level_for_xp(xp) == level` holds by construction
/// - `evs`: per-stat `scale_u32(avg(a.ev, b.ev), FUSION_EFFICIENCY)`
/// - `nickname`: `chosen_nickname` (a fused monster is named by its owner, or
///   unnamed — a parent's nickname is never carried implicitly)
/// - `party_slot`: min of present (Some) slots; `None` if both parents have `None`
/// - `current_hp`: full at the new derived stats
/// - `derived_stats`: derived from the offspring base stats and the TAXED
///   level and EVs
///
/// **Order-independence:** every carry formula is symmetric in `(a, b)` (`max`,
/// `avg`), so `fuse(a, b, s, n) == fuse(b, a, s, n)` for every field EXCEPT
/// `nature` (and the nature-dependent non-HP `derived_stats`) when the two
/// parents' bonds are EQUAL — then the first argument's nature wins. Callers
/// that need a reproducible result regardless of selection order MUST
/// canonicalize parent order first (the M10b reducer's obligation — ADR-0061 §4).
#[must_use]
pub fn fuse(
    a: &MonsterInstance,
    b: &MonsterInstance,
    offspring: &Species,
    chosen_nickname: Option<String>,
) -> MonsterInstance {
    // Per-stat IV max through ONE closure — a field transposition is impossible.
    let iv = |k: StatKind| a.ivs.get(k).max(b.ivs.get(k));
    let ivs = IVs::new(
        iv(StatKind::Hp),
        iv(StatKind::Attack),
        iv(StatKind::Defense),
        iv(StatKind::Speed),
        iv(StatKind::SpAttack),
        iv(StatKind::SpDefense),
    )
    .expect("per-stat max of two <=31 IVs is <=31 by construction");

    // Higher-bond parent's nature; `>=` resolves an equal-bond tie to `a`.
    let nature = if a.bond >= b.bond { a.nature } else { b.nature };

    // Bond: 75% of the max parent bond. max bond 255 → 255*75/100 = 191 <= u8::MAX,
    // so the conversion is provably infallible.
    let bond_raw = u32::from(a.bond.value().max(b.bond.value()));
    let bond = Bond::new(
        u8::try_from(scale_u32(bond_raw, FUSION_EFFICIENCY))
            .expect("max bond 255 * 75 / 100 = 191 <= u8::MAX"),
    );

    // Level: taxed average with a retention floor. Bounds proof: avg <= 100 →
    // 75% <= 75; max <= 100 → 50% <= 50; so level_raw <= 75, and `.max(1)`
    // (reachable only for two level-1 parents, where both branches floor to 0)
    // keeps it >= 1 — `Level::new` over 1..=75 is provably infallible.
    let (la, lb) = (u32::from(a.level.as_u8()), u32::from(b.level.as_u8()));
    let level_raw = scale_u32(avg_u32(la, lb), FUSION_EFFICIENCY)
        .max(scale_u32(la.max(lb), LEVEL_RETENTION_FLOOR))
        .max(1);
    let level = Level::new(u8::try_from(level_raw).expect("level_raw <= 75 <= u8::MAX"))
        .expect("level_raw is in 1..=75 by the .max(1) floor and the 75% ceiling");

    // EVs: 75% of the per-stat average. Bounds proof: each parent stat <= 252
    // (EVs::new cap), so avg <= 252 and 252*75/100 = 189 <= 252 (per-stat cap
    // holds); totals: sum_k floor(0.75*avg_k) <= 0.75 * (510+510)/2 = 382.5, so
    // the total is <= 382 <= 510 (budget cap holds) — `EVs::new` is provably
    // infallible for two individually-valid parents.
    let ev = |k: StatKind| -> u16 {
        u16::try_from(scale_u32(
            avg_u32(u32::from(a.evs.get(k)), u32::from(b.evs.get(k))),
            FUSION_EFFICIENCY,
        ))
        .expect("per-stat avg <= 252 -> taxed <= 189 <= u16::MAX")
    };
    let evs = EVs::new(
        ev(StatKind::Hp),
        ev(StatKind::Attack),
        ev(StatKind::Defense),
        ev(StatKind::Speed),
        ev(StatKind::SpAttack),
        ev(StatKind::SpDefense),
    )
    .expect("per-stat <= 189 <= 252; total <= 382 <= 510");

    let derived = derive_stats(&offspring.base_stats, &ivs, &evs, &nature, level);

    // Min of the PRESENT slots; `None` only if both are `None` (an active parent
    // keeps the offspring active — fusion never silently boxes it).
    let party_slot = [a.party_slot, b.party_slot].into_iter().flatten().min();

    MonsterInstance {
        species_id: offspring.id,
        nickname: chosen_nickname,
        level,
        xp: xp_for_level(level),
        ivs,
        nature,
        evs,
        bond,
        current_hp: derived.hp,
        derived_stats: derived,
        party_slot,
    }
}

// ============================================================================
// Transform unit and boundary tests (M10a-rules, criteria 8–16)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Species;
    // A0 (ADR-0147): the fusion-eligibility gate lives in the sibling `eligibility`
    // module and is re-exported by `evolution::mod` — importing it through the
    // re-export pins that export path as part of the contract.
    use crate::evolution::{fusion_eligible, FusionError};
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
            ability: None,
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

        let offspring = fuse(&a, &b, &sp_off, None);

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

        let offspring = fuse(&a, &b, &sp_off, None);

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

        let offspring = fuse(&a, &b, &sp_off, None);

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

        let offspring = fuse(&a, &b, &sp_off, None);

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
            fuse(&a, &b, &sp_off, None).party_slot,
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
            fuse(&a, &b, &sp_off, None).party_slot,
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
            fuse(&a, &b, &sp_off, None).party_slot,
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
            fuse(&a, &b, &sp_off, None).party_slot,
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
            fuse(&a, &b, &sp_off, None).party_slot,
            None,
            "(None, None) must yield None"
        );
    }

    // -----------------------------------------------------------------------
    // T16 (REWRITE of Criterion 15 `fuse_produces_fresh_body`) — Fuse CARRIES
    // taxed individuality. The fresh-body model (level 1 / EVs::zero() /
    // default_bond() / xp_for_level(L1)) is DELETED by ADR-0147; every field is
    // pinned to an exact hardcoded value, never derived from the constants.
    //
    // Criterion 16 (`fuse_xp_is_consistent_with_level_1`) is DELETED — its
    // level-1 premise is gone; the xp/level pair invariant is folded into T8
    // (and re-asserted here at the taxed level).
    // -----------------------------------------------------------------------

    /// T16 (A0-1..A0-6): distinctive parents → every offspring field pinned exactly.
    ///
    /// Parents: `a` = L34 bond 200 IVs 31 EVs(252,0,100,0,0,0) Adamant "ParentA" slot 0
    ///          `b` = L10 bond 100 IVs  0 EVs(0,252,0,0,0,0)   Timid   "ParentB" slot 3
    #[test]
    fn fuse_carries_taxed_individuality() {
        // kills: level=1 hardcode, EVs::zero(), Bond::default_bond(), xp_for_level(L1),
        //        carrying a parent's nickname, untaxed level/bond/EV carry,
        //        derive_stats fed the wrong base/level/EVs
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 80, 100);
        let sp_off = species(5, 60, 70);

        let a_ivs = IVs::new(31, 31, 31, 31, 31, 31).unwrap();
        let b_ivs = IVs::new(0, 0, 0, 0, 0, 0).unwrap();
        let a_evs = EVs::new(252, 0, 100, 0, 0, 0).unwrap();
        let b_evs = EVs::new(0, 252, 0, 0, 0, 0).unwrap();
        let nat_a = Nature::new(NatureKind::Adamant);
        let nat_b = Nature::new(NatureKind::Timid);
        let lv_a = Level::new(34).unwrap();
        let lv_b = Level::new(10).unwrap();

        let ds_a = derive_stats(&sp_a.base_stats, &a_ivs, &a_evs, &nat_a, lv_a);
        let ds_b = derive_stats(&sp_b.base_stats, &b_ivs, &b_evs, &nat_b, lv_b);

        let a = MonsterInstance {
            species_id: sp_a.id,
            nickname: Some("ParentA".to_string()),
            level: lv_a,
            xp: xp_for_level(lv_a),
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
            level: lv_b,
            xp: xp_for_level(lv_b),
            ivs: b_ivs,
            nature: nat_b,
            evs: b_evs,
            bond: Bond::new(100),
            current_hp: ds_b.hp,
            derived_stats: ds_b,
            party_slot: Some(3),
        };

        let offspring = fuse(&a, &b, &sp_off, None);

        assert_eq!(
            offspring.species_id, 5,
            "species_id must be the offspring species id (5)"
        );

        // A0-1 — IVs: per-stat max (regression guard, unchanged behavior).
        for stat in [
            StatKind::Hp,
            StatKind::Attack,
            StatKind::Defense,
            StatKind::Speed,
            StatKind::SpAttack,
            StatKind::SpDefense,
        ] {
            assert_eq!(
                offspring.ivs.get(stat),
                31,
                "offspring IV for {stat:?} must be max(31, 0) = 31"
            );
        }

        // Nature: higher-bond parent (a, bond 200 > 100).
        assert_eq!(
            offspring.nature, nat_a,
            "nature must come from the higher-bond parent (a, Adamant)"
        );

        // A0-2 — bond: taxed max, 200 * 75 / 100 = 150 (NEVER default_bond() 70).
        assert_eq!(
            offspring.bond,
            Bond::new(150),
            "bond must be the taxed max 150 — never Bond::default_bond() (70) and never the untaxed 200"
        );

        // A0-3 — level: max(taxed avg 16, retained floor 17) = 17 (NEVER 1).
        assert_eq!(
            offspring.level.as_u8(),
            17,
            "level must be 17 for parents (34, 10) — never 1, never the untaxed avg 22"
        );

        // A0-4 — xp: 17^3 = 4913, and the level/xp pair round-trips.
        assert_eq!(offspring.xp, Xp::new(4913), "xp must be 17^3 = 4913");
        assert_eq!(
            offspring.xp,
            xp_for_level(Level::new(17).unwrap()),
            "xp must equal xp_for_level(offspring.level)"
        );
        assert_eq!(
            level_for_xp(offspring.xp).as_u8(),
            17,
            "level_for_xp(offspring.xp) must round-trip to the offspring level (17)"
        );

        // A0-5 — EVs: per-stat taxed average (NEVER zero).
        assert_eq!(
            offspring.evs.get(StatKind::Hp),
            94,
            "HP EV: avg(252, 0) = 126, taxed = 94"
        );
        assert_eq!(
            offspring.evs.get(StatKind::Attack),
            94,
            "Atk EV: avg(0, 252) = 126, taxed = 94"
        );
        assert_eq!(
            offspring.evs.get(StatKind::Defense),
            37,
            "Def EV: avg(100, 0) = 50, taxed = 37"
        );
        assert_eq!(
            offspring.evs.get(StatKind::Speed),
            0,
            "Spd EV: avg(0, 0) = 0, taxed = 0"
        );
        assert_eq!(
            offspring.evs.get(StatKind::SpAttack),
            0,
            "SpA EV: avg(0, 0) = 0, taxed = 0"
        );
        assert_eq!(
            offspring.evs.get(StatKind::SpDefense),
            0,
            "SpD EV: avg(0, 0) = 0, taxed = 0"
        );
        assert_eq!(
            offspring.evs.total(),
            225,
            "EV total must be 94 + 94 + 37 = 225 — never 0"
        );

        // A0-6 — nickname: `None` was chosen, so the parents' names must NOT carry.
        assert_eq!(
            offspring.nickname, None,
            "nickname must be None when chosen_nickname is None — never a parent's nickname"
        );

        // party_slot: min of present slots (unchanged behavior).
        assert_eq!(
            offspring.party_slot,
            Some(0),
            "party_slot must be min(Some(0), Some(3)) = Some(0)"
        );

        // current_hp: FULL at the taxed level.
        assert_eq!(
            offspring.current_hp, offspring.derived_stats.hp,
            "current_hp must equal derived HP (full) at the taxed level"
        );
        assert!(offspring.current_hp > 0, "current_hp must be > 0");

        // derived_stats SSOT: offspring base stats + TAXED level + TAXED EVs.
        let expected_derived = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &offspring.evs,
            &offspring.nature,
            offspring.level,
        );
        assert_eq!(
            offspring.derived_stats, expected_derived,
            "derived_stats must equal derive_stats(offspring.base_stats, offspring.ivs, offspring.evs, offspring.nature, offspring.level)"
        );
    }

    // =======================================================================
    // A0 (ADR-0147) — carry/tax arithmetic + fusion eligibility interaction
    //
    // Every expected value below is HARDCODED from the spec's worked examples.
    // No expectation is computed from FUSION_EFFICIENCY / LEVEL_RETENTION_FLOOR /
    // MIN_FUSION_* (a silent retune of a constant MUST turn these red).
    // =======================================================================

    /// Build a fusion parent with explicit level/bond/EVs/IVs/nature. `xp`,
    /// `derived_stats` and `current_hp` are kept mutually consistent so the
    /// fixture is a monster the real marshal layer would accept.
    fn parent_with(
        sp: &Species,
        level: u8,
        bond_val: u8,
        evs: EVs,
        ivs: IVs,
        nature: Nature,
    ) -> MonsterInstance {
        let level = Level::new(level).unwrap();
        let derived_stats = derive_stats(&sp.base_stats, &ivs, &evs, &nature, level);
        MonsterInstance {
            species_id: sp.id,
            nickname: None,
            level,
            xp: xp_for_level(level),
            ivs,
            nature,
            evs,
            bond: Bond::new(bond_val),
            current_hp: derived_stats.hp,
            derived_stats,
            party_slot: None,
        }
    }

    /// `parent_with` using neutral IVs (15 across the board) and a Hardy nature.
    fn parent(sp: &Species, level: u8, bond_val: u8, evs: EVs) -> MonsterInstance {
        parent_with(
            sp,
            level,
            bond_val,
            evs,
            IVs::new(15, 15, 15, 15, 15, 15).unwrap(),
            Nature::new(NatureKind::Hardy),
        )
    }

    // -----------------------------------------------------------------------
    // T1 / T2 — the private arithmetic primitives (reachable via `use super::*`)
    // -----------------------------------------------------------------------

    /// T1: `scale_u32(v, pct) == v * pct / 100` with TRUNCATING division.
    #[test]
    fn scale_u32_pins() {
        // kills: round-half-up / ceil, pct-inverted (v*100/pct), percent-of-percent,
        //        saturating clamps, a no-op identity stub
        assert_eq!(scale_u32(100, 75), 75, "scale_u32(100, 75) must be 75");
        assert_eq!(scale_u32(34, 50), 17, "scale_u32(34, 50) must be 17");
        assert_eq!(
            scale_u32(1, 75),
            0,
            "scale_u32(1, 75) must FLOOR to 0 (kills ceil / round-half-up)"
        );
        assert_eq!(
            scale_u32(255, 75),
            191,
            "scale_u32(255, 75) must be 191 (191.25 floored) — the bond-ceiling proof"
        );
    }

    /// T2: `avg_u32(a, b) == (a + b) / 2` with TRUNCATING division, symmetric.
    #[test]
    fn avg_u32_pins() {
        // kills: max/min substitution, a-only, b-only, round-up, u8-width overflow
        assert_eq!(avg_u32(34, 10), 22, "avg_u32(34, 10) must be 22");
        assert_eq!(
            avg_u32(11, 10),
            10,
            "avg_u32(11, 10) must FLOOR to 10 (kills round-up and max)"
        );
        assert_eq!(avg_u32(0, 0), 0, "avg_u32(0, 0) must be 0");
        assert_eq!(
            avg_u32(255, 255),
            255,
            "avg_u32(255, 255) must be 255 (u32 intermediate — no u8 overflow)"
        );
        assert_eq!(avg_u32(10, 34), 22, "avg_u32 must be symmetric");
    }

    // -----------------------------------------------------------------------
    // T3 / T3b / T4 — A0-2 bond = taxed MAX of the parents
    // -----------------------------------------------------------------------

    /// T3: parents (200, 100) → offspring bond 150, in BOTH argument orders.
    #[test]
    fn fuse_bond_is_taxed_max_of_parents() {
        // kills: min, untaxed max (200), taxed average (112), Bond::default_bond() (70);
        //        the swapped order kills a-only (75) and the first order kills b-only (75)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 20, 200, EVs::zero());
        let b = parent(&sp_b, 20, 100, EVs::zero());

        assert_eq!(
            fuse(&a, &b, &sp_off, None).bond,
            Bond::new(150),
            "bond must be max(200, 100) * 75 / 100 = 150"
        );
        assert_eq!(
            fuse(&b, &a, &sp_off, None).bond,
            Bond::new(150),
            "bond must be 150 with the parents swapped (kills a-only / b-only forms)"
        );
    }

    /// T3b: the WEAKER parent's bond is irrelevant — (255, 120) and (255, 255)
    /// both yield 191.
    #[test]
    fn fuse_bond_ignores_the_weaker_parent() {
        // kills: taxed average (avg(255,120)=187 -> 140), taxed min (90), sum-based forms
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let strong = parent(&sp_a, 20, 255, EVs::zero());
        let weak = parent(&sp_b, 20, 120, EVs::zero());
        let also_strong = parent(&sp_b, 20, 255, EVs::zero());

        let mixed = fuse(&strong, &weak, &sp_off, None).bond;
        let both_strong = fuse(&strong, &also_strong, &sp_off, None).bond;

        assert_eq!(
            mixed,
            Bond::new(191),
            "bond must be max(255, 120) * 75 / 100 = 191"
        );
        assert_eq!(
            mixed, both_strong,
            "the weaker parent's bond must not affect the offspring bond at all"
        );
    }

    /// T4: the bond ceiling — two 255-bond parents → 191, never a u8 overflow.
    #[test]
    fn fuse_bond_ceiling_is_191() {
        // kills: `u8` intermediate overflow (255 * 75 wraps), untaxed 255, saturate-at-255
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 20, 255, EVs::zero());
        let b = parent(&sp_b, 20, 255, EVs::zero());

        assert_eq!(
            fuse(&a, &b, &sp_off, None).bond,
            Bond::new(191),
            "max bond 255 * 75 / 100 = 191 — the u8 headroom proof"
        );
    }

    // -----------------------------------------------------------------------
    // T5 / T6 / T7 — A0-3 level = max(taxed avg, retained floor).max(1)
    // -----------------------------------------------------------------------

    /// T5: the five spec-pinned worked examples, in both argument orders.
    #[test]
    fn fuse_level_matches_spec_worked_examples() {
        // kills avg-branch-only: (34,10)->16, (60,10)->26, (100,10)->41 all differ
        // kills floor-branch-only: (12,10)->6, (34,34)->17 both differ
        // kills 75<->50 swap: (34,10) would give 25; kills untaxed avg (22) and untaxed max (34)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);

        for (la, lb, expected) in [
            (34u8, 10u8, 17u8),
            (12, 10, 8),
            (60, 10, 30),
            (100, 10, 50),
            (34, 34, 25),
        ] {
            let a = parent(&sp_a, la, 200, EVs::zero());
            let b = parent(&sp_b, lb, 200, EVs::zero());
            assert_eq!(
                fuse(&a, &b, &sp_off, None).level.as_u8(),
                expected,
                "parents ({la}, {lb}) must fuse to level {expected}"
            );
            assert_eq!(
                fuse(&b, &a, &sp_off, None).level.as_u8(),
                expected,
                "parents ({lb}, {la}) (swapped) must also fuse to level {expected}"
            );
        }
    }

    /// T6: two level-1 parents → level 1 (the `.max(1)` floor).
    ///
    /// UNREACHABLE through the real `fuse` reducer (`MIN_FUSION_LEVEL = 10` gates
    /// it) — this is a PURE-TOTALITY pin: without the floor, both branches yield 0
    /// and `Level::new(0)` panics (`.expect` in a reducer path = a wasm trap).
    #[test]
    fn fuse_level_floor_is_one_for_two_level_one_parents() {
        // kills: dropping `.max(1)` (Level::new(0) panics), and any "return 0" stub
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 1, 200, EVs::zero());
        let b = parent(&sp_b, 1, 200, EVs::zero());

        assert_eq!(
            fuse(&a, &b, &sp_off, None).level.as_u8(),
            1,
            "two level-1 parents must floor to level 1, never level 0"
        );
    }

    /// T7: the level ceiling — two level-100 parents → 75.
    #[test]
    fn fuse_level_ceiling_is_75() {
        // kills: uncapped carry (100), floor-branch-only (50), `u8` overflow proofs
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 100, 200, EVs::zero());
        let b = parent(&sp_b, 100, 200, EVs::zero());

        assert_eq!(
            fuse(&a, &b, &sp_off, None).level.as_u8(),
            75,
            "two level-100 parents must fuse to level 75 — the taxed ceiling"
        );
    }

    // -----------------------------------------------------------------------
    // T8 — A0-4 xp is the taxed level's xp (level/xp pair invariant)
    // -----------------------------------------------------------------------

    /// T8: parents (34, 10) → level 17, xp 4913, and `level_for_xp` round-trips.
    /// (Folds in the deleted `fuse_xp_is_consistent_with_level_1`.)
    #[test]
    fn fuse_xp_matches_the_taxed_level() {
        // kills: xp_for_level(L1) hardcode (1), xp carried from a parent (34^3 = 39304),
        //        xp = 0, xp desynced from the level it ships with
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 34, 200, EVs::zero());
        let b = parent(&sp_b, 10, 200, EVs::zero());

        let offspring = fuse(&a, &b, &sp_off, None);

        assert_eq!(
            offspring.level.as_u8(),
            17,
            "fixture sanity: parents (34, 10) fuse to level 17"
        );
        assert_eq!(offspring.xp, Xp::new(4913), "xp must be 17^3 = 4913");
        assert_eq!(
            offspring.xp,
            xp_for_level(Level::new(17).unwrap()),
            "xp must equal xp_for_level(17)"
        );
        assert_eq!(
            level_for_xp(offspring.xp).as_u8(),
            17,
            "level_for_xp(offspring.xp) must equal offspring.level (the pair invariant)"
        );
    }

    // -----------------------------------------------------------------------
    // T9 / T10 — A0-5 per-stat EVs = taxed average
    // -----------------------------------------------------------------------

    /// T9: a = (252,0,100,0,0,0), b = (0,252,0,0,0,0) → (94,94,37,0,0,0).
    #[test]
    fn fuse_evs_are_the_taxed_per_stat_average() {
        // kills: EVs::zero(), untaxed average (126/126/50), per-stat max (189/189/75),
        //        stat transposition (Def 37 vs Spd 0 is asymmetric), a-only / b-only
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 20, 200, EVs::new(252, 0, 100, 0, 0, 0).unwrap());
        let b = parent(&sp_b, 20, 200, EVs::new(0, 252, 0, 0, 0, 0).unwrap());

        let evs = fuse(&a, &b, &sp_off, None).evs;

        assert_eq!(
            evs.get(StatKind::Hp),
            94,
            "HP EV: avg(252, 0) = 126, taxed = 94"
        );
        assert_eq!(
            evs.get(StatKind::Attack),
            94,
            "Atk EV: avg(0, 252) = 126, taxed = 94"
        );
        assert_eq!(
            evs.get(StatKind::Defense),
            37,
            "Def EV: avg(100, 0) = 50, taxed = 37"
        );
        assert_eq!(evs.get(StatKind::Speed), 0, "Spd EV must be 0");
        assert_eq!(evs.get(StatKind::SpAttack), 0, "SpA EV must be 0");
        assert_eq!(evs.get(StatKind::SpDefense), 0, "SpD EV must be 0");
        assert_eq!(
            evs.total(),
            225,
            "EV total must be 94 + 94 + 37 = 225 — never 0"
        );
    }

    /// T10: both parents at the EV cap (252,252,6,0,0,0) (total 510) →
    /// (189,189,4,0,0,0), total 382 — the `EVs::new(..).expect(..)` headroom proof.
    #[test]
    fn fuse_evs_ceiling_stays_within_the_caps() {
        // kills: the untaxed carry (252 > the 189 attained ceiling, total 510),
        //        any per-stat cap violation that would make EVs::new(..) panic
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let maxed = EVs::new(252, 252, 6, 0, 0, 0).unwrap();
        let a = parent(&sp_a, 20, 200, maxed);
        let b = parent(&sp_b, 20, 200, maxed);

        let evs = fuse(&a, &b, &sp_off, None).evs;

        assert_eq!(
            evs.get(StatKind::Hp),
            189,
            "HP EV: avg(252, 252) = 252, taxed = 189 (<= the 252 per-stat cap)"
        );
        assert_eq!(
            evs.get(StatKind::Attack),
            189,
            "Atk EV: avg(252, 252) = 252, taxed = 189"
        );
        assert_eq!(
            evs.get(StatKind::Defense),
            4,
            "Def EV: avg(6, 6) = 6, taxed = 4"
        );
        assert_eq!(
            evs.total(),
            382,
            "EV total must be 189 + 189 + 4 = 382 (<= the 510 budget) — the attained ceiling"
        );
    }

    // -----------------------------------------------------------------------
    // T11 / T12 — A0-7 derived stats come from the TAXED level and TAXED EVs
    // -----------------------------------------------------------------------

    /// T11: `derived_stats == derive_stats(off.base, off.ivs, off.evs, off.nature,
    /// off.level)` with a NON-1 level and NON-zero EVs, plus explicit non-vacuity
    /// (the level-1 and zero-EV derivations are provably different values).
    #[test]
    fn fuse_derives_stats_from_the_taxed_level_and_taxed_evs() {
        // kills: derive_stats(..., Level 1) ("fresh body" leftover),
        //        derive_stats(..., &EVs::zero()) then assigning taxed EVs afterwards,
        //        deriving from a PARENT's base stats
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 80, 100);
        let sp_off = species(3, 60, 70);
        let nat = Nature::new(NatureKind::Hardy);
        let a = parent_with(
            &sp_a,
            34,
            200,
            EVs::new(252, 0, 100, 0, 0, 0).unwrap(),
            IVs::new(31, 31, 31, 31, 31, 31).unwrap(),
            nat,
        );
        let b = parent_with(
            &sp_b,
            10,
            100,
            EVs::new(0, 252, 0, 0, 0, 0).unwrap(),
            IVs::new(0, 0, 0, 0, 0, 0).unwrap(),
            nat,
        );

        let offspring = fuse(&a, &b, &sp_off, None);

        // Fixture non-vacuity: the offspring is NOT a level-1 zero-EV body.
        assert_eq!(
            offspring.level.as_u8(),
            17,
            "fixture sanity: the taxed level is 17, not 1"
        );
        assert_eq!(
            offspring.evs.total(),
            225,
            "fixture sanity: the taxed EV total is 225, not 0"
        );

        let expected = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &offspring.evs,
            &offspring.nature,
            offspring.level,
        );
        assert_eq!(
            offspring.derived_stats, expected,
            "derived_stats must be derived from the offspring species, the TAXED level and the TAXED EVs"
        );

        // Teeth: the two plausible wrong derivations produce DIFFERENT stat blocks.
        let at_level_one = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &offspring.evs,
            &offspring.nature,
            Level::new(1).unwrap(),
        );
        assert_ne!(
            offspring.derived_stats, at_level_one,
            "a level-1 derivation must be observably different (non-vacuous teeth)"
        );
        let with_zero_evs = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &EVs::zero(),
            &offspring.nature,
            offspring.level,
        );
        assert_ne!(
            offspring.derived_stats, with_zero_evs,
            "a zero-EV derivation must be observably different (non-vacuous teeth)"
        );
    }

    /// T12: `current_hp` is FULL at the taxed level (not carried, not the L1 body).
    #[test]
    fn fuse_current_hp_is_full_at_the_taxed_level() {
        // kills: current_hp carried from a parent, half-HP starts,
        //        current_hp taken from a level-1 derivation
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 70);
        let a = parent(&sp_a, 34, 200, EVs::zero());
        let b = parent(&sp_b, 10, 200, EVs::zero());

        let offspring = fuse(&a, &b, &sp_off, None);

        assert_eq!(
            offspring.current_hp, offspring.derived_stats.hp,
            "current_hp must equal derived HP (full) at the taxed level"
        );
        assert!(offspring.current_hp > 0, "current_hp must be > 0");

        let level_one_hp = derive_stats(
            &sp_off.base_stats,
            &offspring.ivs,
            &offspring.evs,
            &offspring.nature,
            Level::new(1).unwrap(),
        )
        .hp;
        assert!(
            offspring.current_hp > level_one_hp,
            "current_hp ({}) must exceed the level-1 HP ({}) — the offspring is not a fresh L1 body",
            offspring.current_hp,
            level_one_hp
        );
    }

    // -----------------------------------------------------------------------
    // T13 — A0-6 `chosen_nickname` plumbing
    // -----------------------------------------------------------------------

    /// T13a: `None` → `None`, even when BOTH parents are named.
    #[test]
    fn fuse_nickname_is_none_when_none_is_chosen() {
        // kills: carrying a.nickname / b.nickname / a default "Fusion" string
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let mut a = parent(&sp_a, 20, 200, EVs::zero());
        let mut b = parent(&sp_b, 20, 200, EVs::zero());
        a.nickname = Some("ParentA".to_string());
        b.nickname = Some("ParentB".to_string());

        assert_eq!(
            fuse(&a, &b, &sp_off, None).nickname,
            None,
            "chosen_nickname None must yield None even when both parents are named"
        );
    }

    /// T13b: `Some(s)` → `Some(s)` verbatim (no truncation, no parent override).
    #[test]
    fn fuse_nickname_uses_the_chosen_value() {
        // kills: ignoring the new parameter, overwriting it with a parent's nickname
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let mut a = parent(&sp_a, 20, 200, EVs::zero());
        let b = parent(&sp_b, 20, 200, EVs::zero());
        a.nickname = Some("ParentA".to_string());

        assert_eq!(
            fuse(&a, &b, &sp_off, Some("Steamy".to_string())).nickname,
            Some("Steamy".to_string()),
            "chosen_nickname Some(s) must be used verbatim"
        );
    }

    // -----------------------------------------------------------------------
    // T14 / T15 — A0-8 the bond tax closes the "reusable carrier" loop
    // -----------------------------------------------------------------------

    /// T14 (A0-8, pure half): two bond-120 parents → offspring bond 90, and that
    /// offspring is then REJECTED by `fusion_eligible` for bond.
    #[test]
    fn fuse_bond_120_parents_produce_a_bond_ineligible_offspring() {
        // kills: an untaxed bond carry (would give 120 -> Ok, re-opening the exploit)
        // kills: dropping the bond check from fusion_eligible
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 20, 120, EVs::zero());
        let b = parent(&sp_b, 20, 120, EVs::zero());

        let offspring = fuse(&a, &b, &sp_off, None);

        assert_eq!(
            offspring.bond,
            Bond::new(90),
            "bond 120 parents must yield offspring bond 90 (120 * 75 / 100)"
        );
        assert_eq!(
            offspring.level.as_u8(),
            15,
            "fixture sanity: the offspring is level 15, so LEVEL is not the failing gate"
        );

        // Paired with a fully eligible partner, BOND is the only reason to reject.
        let partner = parent(&sp_a, 50, 200, EVs::zero());
        assert_eq!(
            fusion_eligible(1, 2, &offspring, &partner),
            Err(FusionError::BelowMinBond),
            "a bond-90 offspring must be rejected as BelowMinBond when re-fused"
        );
    }

    /// T15 (honesty pin, plan R8): the bond tax is a TAX, not a LOCK — parents at
    /// bond 160 still produce an offspring that clears the 120 minimum.
    #[test]
    fn fuse_bond_160_parents_produce_a_still_eligible_offspring() {
        // kills: an over-claiming "fusion output can never be re-fused" impl
        //        (e.g. clamping the offspring bond below MIN_FUSION_BOND)
        let sp_a = species(1, 45, 49);
        let sp_b = species(2, 45, 49);
        let sp_off = species(3, 60, 60);
        let a = parent(&sp_a, 20, 160, EVs::zero());
        let b = parent(&sp_b, 20, 160, EVs::zero());

        let offspring = fuse(&a, &b, &sp_off, None);

        assert_eq!(
            offspring.bond,
            Bond::new(120),
            "bond 160 parents must yield offspring bond 120 (160 * 75 / 100)"
        );
        let partner = parent(&sp_a, 50, 200, EVs::zero());
        assert_eq!(
            fusion_eligible(1, 2, &offspring, &partner),
            Ok(()),
            "a bond-120 offspring still clears MIN_FUSION_BOND — the tax decays, it does not lock"
        );
    }
}
