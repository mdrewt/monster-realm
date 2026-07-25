//! M10a gating tests — cross-cutting proof-of-teeth for the evolution rules.
//!
//! Covers criteria 17–22 from the M10a spec:
//!   17. DETERMINISM: evolve + fuse are byte-identical on repeated calls.
//!   18. FUSION ORDER-INDEPENDENCE: fuse(a,b,s) == fuse(b,a,s) when a.bond != b.bond
//!       (full equality); order-independent subset when bonds are equal.
//!   19. Exhaustiveness guard comment (no wildcard arm on EvolutionTrigger).
//!   20. Property: evolve — current_hp <= derived_stats.hp, never panics.
//!   21. Property (A0/ADR-0147 REWRITE): fuse — totality + carry invariants:
//!       never panics, IVs<=31, 1<=level<=75, per-stat EV<=189, EV total<=382,
//!       current_hp==derived.hp>0, xp==xp_for_level(level).
//!   22. Property: fuse IVs per stat == max of parents (property form of criterion 11).
//!   25. Property (A0/ADR-0147 NEW): fuse level == an independent recomputation
//!       of the A0-3 formula with LITERAL 75/50 (the ONLY sanctioned formula
//!       mirror in this suite — every other expectation is a hardcoded pin).
//!
//! Red state: every test will PANIC on the `todo!()` stubs.
//! Run: cargo test m10a_gating -- --nocapture

use crate::content::Species;
use crate::evolution::{evolve, fuse};
use crate::monster::rules::{derive_stats, xp_for_level};
use crate::monster::types::{
    Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, StatKind,
};

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

fn lv(n: u8) -> Level {
    Level::new(n).unwrap()
}

fn species(id: u32, hp: u16, other: u16) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: StatBlock {
            hp,
            attack: other,
            defense: other,
            speed: other,
            sp_attack: other,
            sp_defense: other,
        },
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
        ability: None,
    }
}

fn default_base() -> StatBlock {
    StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    }
}

#[allow(clippy::too_many_arguments)]
fn make_monster(
    species_id: u32,
    ivs: IVs,
    nature: Nature,
    evs: EVs,
    bond: Bond,
    level: Level,
    nickname: Option<String>,
    party_slot: Option<u8>,
    base: &StatBlock,
) -> MonsterInstance {
    let derived_stats = derive_stats(base, &ivs, &evs, &nature, level);
    MonsterInstance {
        species_id,
        nickname,
        level,
        xp: xp_for_level(level),
        ivs,
        nature,
        evs,
        bond,
        current_hp: derived_stats.hp,
        derived_stats,
        party_slot,
    }
}

// ---------------------------------------------------------------------------
// Criterion 17 — DETERMINISM
// kills: hidden RNG / clock / global mutable state
// ---------------------------------------------------------------------------

/// Criterion 17a: `evolve` twice on identical input → byte-identical MonsterInstance.
/// kills: any hidden RNG, wall-clock read, or global counter inside evolve.
#[test]
fn evolve_is_deterministic() {
    // kills: hidden RNG/clock/global state in evolve
    let source_sp = species(1, 45, 49);
    let target_sp = species(2, 80, 100);

    let ivs = IVs::new(10, 15, 20, 25, 5, 31).unwrap();
    let nature = Nature::new(NatureKind::Adamant);
    let evs = EVs::new(100, 50, 0, 0, 0, 0).unwrap();
    let monster = make_monster(
        source_sp.id,
        ivs,
        nature,
        evs,
        Bond::new(180),
        lv(30),
        Some("Ember".to_string()),
        Some(2),
        &default_base(),
    );

    let result_a = evolve(&monster, &target_sp);
    let result_b = evolve(&monster, &target_sp);

    assert_eq!(
        result_a, result_b,
        "evolve must be byte-identical on repeated calls with the same input"
    );
}

/// Criterion 17b: `fuse` twice on identical inputs → byte-identical MonsterInstance.
/// kills: any hidden RNG, wall-clock read, or global counter inside fuse.
#[test]
fn fuse_is_deterministic() {
    // kills: hidden RNG/clock/global state in fuse
    let sp_a = species(1, 45, 49);
    let sp_b = species(2, 80, 100);
    let sp_off = species(3, 60, 70);

    let a_ivs = IVs::new(10, 31, 5, 20, 0, 15).unwrap();
    let b_ivs = IVs::new(31, 5, 20, 0, 15, 10).unwrap();
    let nat_a = Nature::new(NatureKind::Adamant);
    let nat_b = Nature::new(NatureKind::Timid);

    let base = default_base();
    let a = make_monster(
        sp_a.id,
        a_ivs,
        nat_a,
        EVs::zero(),
        Bond::new(100),
        lv(30),
        Some("Alpha".to_string()),
        Some(1),
        &base,
    );
    let b = make_monster(
        sp_b.id,
        b_ivs,
        nat_b,
        EVs::new(100, 50, 0, 0, 0, 0).unwrap(),
        Bond::new(200),
        lv(25),
        Some("Beta".to_string()),
        Some(3),
        &base,
    );

    let result_a = fuse(&a, &b, &sp_off, None);
    let result_b = fuse(&a, &b, &sp_off, None);

    assert_eq!(
        result_a, result_b,
        "fuse must be byte-identical on repeated calls with the same inputs"
    );
}

// ---------------------------------------------------------------------------
// Criterion 18 — FUSION ORDER-INDEPENDENCE
// kills: order-dependent IV/slot computation
// ---------------------------------------------------------------------------

/// Criterion 18a: fuse(a,b,s) == fuse(b,a,s) when a.bond != b.bond (FULL equality).
/// When bonds differ, the nature is determined by the higher-bond parent regardless
/// of argument order, so full equality must hold.
#[test]
fn fuse_is_order_independent_when_bonds_differ() {
    // kills: order-dependent IV max (e.g. "always take a's IV when equal" for any stat)
    // kills: order-dependent slot computation
    let sp_a = species(1, 45, 49);
    let sp_b = species(2, 45, 49);
    let sp_off = species(3, 60, 70);

    let a_ivs = IVs::new(10, 31, 5, 20, 0, 15).unwrap();
    let b_ivs = IVs::new(31, 5, 20, 0, 15, 10).unwrap();
    let nat_a = Nature::new(NatureKind::Adamant);
    let nat_b = Nature::new(NatureKind::Timid);

    let base = default_base();
    // a has LOWER bond, b has HIGHER bond — nature always goes to b regardless of order
    let a = make_monster(
        sp_a.id,
        a_ivs,
        nat_a,
        EVs::zero(),
        Bond::new(100),
        lv(20),
        Some("Alpha".to_string()),
        Some(5),
        &base,
    );
    let b = make_monster(
        sp_b.id,
        b_ivs,
        nat_b,
        EVs::zero(),
        Bond::new(200),
        lv(15),
        Some("Beta".to_string()),
        Some(3),
        &base,
    );

    let ab = fuse(&a, &b, &sp_off, None);
    let ba = fuse(&b, &a, &sp_off, None);

    assert_eq!(
        ab, ba,
        "fuse(a,b,s) must equal fuse(b,a,s) when bonds differ \
         (nature is determined by higher-bond parent regardless of argument order)"
    );
}

/// Criterion 18b: fuse(a,b,s) and fuse(b,a,s) when bonds ARE EQUAL —
/// the order-independent SUBSET must be equal; nature is the ONLY order-sensitive field.
#[test]
fn fuse_order_independent_subset_when_bonds_equal() {
    // kills: IV max being order-dependent when a.iv == b.iv for a stat
    // Note: nature MAY differ (a-wins-on-tie is the spec rule, so fuse(a,b) gives a's nature,
    // fuse(b,a) gives b's nature). Only the order-independent fields are asserted here.
    let sp_a = species(1, 45, 49);
    let sp_b = species(2, 45, 49);
    let sp_off = species(3, 60, 70);

    let a_ivs = IVs::new(10, 31, 5, 20, 0, 15).unwrap();
    let b_ivs = IVs::new(31, 5, 20, 0, 15, 10).unwrap();
    let nat_a = Nature::new(NatureKind::Adamant);
    let nat_b = Nature::new(NatureKind::Timid);

    let base = default_base();
    // EQUAL bonds — nature is order-sensitive (a-wins-on-tie), IVs/slot are not
    let a = make_monster(
        sp_a.id,
        a_ivs,
        nat_a,
        EVs::zero(),
        Bond::new(150),
        lv(20),
        Some("Alpha".to_string()),
        Some(5),
        &base,
    );
    let b = make_monster(
        sp_b.id,
        b_ivs,
        nat_b,
        EVs::zero(),
        Bond::new(150),
        lv(20),
        Some("Beta".to_string()),
        Some(3),
        &base,
    );

    let ab = fuse(&a, &b, &sp_off, None);
    let ba = fuse(&b, &a, &sp_off, None);

    // ORDER-INDEPENDENT subset: IVs, party_slot, level, evs, bond, current_hp, xp
    // (nature is the ONLY order-sensitive field — see comment below)
    let all_stats = [
        StatKind::Hp,
        StatKind::Attack,
        StatKind::Defense,
        StatKind::Speed,
        StatKind::SpAttack,
        StatKind::SpDefense,
    ];
    for stat in all_stats {
        assert_eq!(
            ab.ivs.get(stat),
            ba.ivs.get(stat),
            "IVs must be order-independent for stat {:?}",
            stat
        );
    }
    assert_eq!(
        ab.party_slot, ba.party_slot,
        "party_slot must be order-independent"
    );
    assert_eq!(
        ab.level.as_u8(),
        ba.level.as_u8(),
        "level must be order-independent"
    );
    assert_eq!(ab.evs, ba.evs, "evs must be order-independent");
    assert_eq!(ab.bond, ba.bond, "bond must be order-independent");
    assert_eq!(
        ab.current_hp, ba.current_hp,
        "current_hp must be order-independent"
    );
    assert_eq!(ab.xp, ba.xp, "xp must be order-independent");
    assert_eq!(
        ab.species_id, ba.species_id,
        "species_id must be order-independent"
    );
    assert_eq!(
        ab.nickname, ba.nickname,
        "nickname must be order-independent"
    );

    // Document: nature IS the only order-sensitive field (a-wins-on-tie vs b-wins-on-tie)
    // fuse(a,b) gives a's nature (Adamant); fuse(b,a) gives b's nature (Adamant becomes the "a" arg, so Timid in ba)
    // We do NOT assert nature equality here; we assert the rest is equal.
    // This comment is the spec documentation for the only allowed order-sensitivity.
}

// ---------------------------------------------------------------------------
// #19 — Exhaustiveness guard (no wildcard arm on EvolutionTrigger)
//
// This is a COMPILER-LEVEL gate, not a runtime test. The implementation of
// `resolve_evolution` in `eligibility.rs` MUST use an exhaustive match on
// `EvolutionTrigger` with NO wildcard `_` arm. Adding a new `EvolutionTrigger`
// variant to `content.rs` must therefore produce a compile error in `eligibility.rs`,
// forcing the implementer to handle the new trigger explicitly.
//
// The spec forbids `#[non_exhaustive]` on `EvolutionTrigger` for exactly this
// reason: `non_exhaustive` would silently allow wildcard arms that miss new
// variants. The compile error IS the gate — no runtime test can replicate it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Proptest strategies (mirrors monster/rules.rs + raising/m9a_gating_tests.rs)
// ---------------------------------------------------------------------------

fn arb_ivs() -> impl Strategy<Value = IVs> {
    (0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31)
        .prop_map(|(hp, atk, def, spd, spa, spd2)| IVs::new(hp, atk, def, spd, spa, spd2).unwrap())
}

fn arb_evs() -> impl Strategy<Value = EVs> {
    (
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
    )
        .prop_filter("total must be <= 510", |(a, b, c, d, e, f)| {
            a + b + c + d + e + f <= 510
        })
        .prop_map(|(hp, atk, def, spd, spa, spd2)| EVs::new(hp, atk, def, spd, spa, spd2).unwrap())
}

fn arb_nature() -> impl Strategy<Value = Nature> {
    (0u8..25).prop_map(Nature::from_index)
}

fn arb_level() -> impl Strategy<Value = Level> {
    (1u8..=100).prop_map(|v| Level::new(v).unwrap())
}

/// Realistic base stats [1, 255] per stat.
fn arb_base_stats() -> impl Strategy<Value = StatBlock> {
    (
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
    )
        .prop_map(|(hp, atk, def, spd, spa, spd2)| StatBlock {
            hp,
            attack: atk,
            defense: def,
            speed: spd,
            sp_attack: spa,
            sp_defense: spd2,
        })
}

/// A valid `MonsterInstance` for property tests (current_hp == derived.hp for simplicity).
fn arb_monster(species_id: u32) -> impl Strategy<Value = MonsterInstance> {
    (
        arb_ivs(),
        arb_evs(),
        arb_nature(),
        arb_level(),
        arb_base_stats(),
        0u8..=255,
        any::<bool>(),
        0u8..5,
    )
        .prop_map(
            move |(ivs, evs, nature, level, base, bond_val, has_slot, slot)| {
                let derived_stats = derive_stats(&base, &ivs, &evs, &nature, level);
                let current_hp = derived_stats.hp;
                MonsterInstance {
                    species_id,
                    nickname: None,
                    level,
                    xp: xp_for_level(level),
                    ivs,
                    nature,
                    evs,
                    bond: Bond::new(bond_val),
                    current_hp,
                    derived_stats,
                    party_slot: if has_slot { Some(slot) } else { None },
                }
            },
        )
}

/// A valid `Species` for property tests.
fn arb_species(id: u32) -> impl Strategy<Value = Species> {
    arb_base_stats().prop_map(move |base_stats| Species {
        id,
        name: format!("ArbSpecies{id}"),
        base_stats,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
        ability: None,
    })
}

// ---------------------------------------------------------------------------
// Criterion 20 — Property: evolve output never panics; current_hp <= derived.hp
// kills: impl that panics on valid inputs; impl that forgets the clamp
// ---------------------------------------------------------------------------

proptest! {
    /// Criterion 20: for arbitrary valid monster + target species, evolve:
    /// (a) never panics, (b) current_hp <= derived_stats.hp.
    #[test]
    fn evolve_totality_and_hp_clamp_invariant(
        monster in arb_monster(1),
        target in arb_species(2),
    ) {
        // kills: an impl that panics on any valid input
        // kills: an impl that forgets to clamp current_hp to new derived HP
        let result = evolve(&monster, &target);
        prop_assert!(
            result.current_hp <= result.derived_stats.hp,
            "current_hp ({}) must be <= derived_stats.hp ({}) after evolve",
            result.current_hp,
            result.derived_stats.hp
        );
    }

    // ---------------------------------------------------------------------------
    // Criterion 20 (supplemental) — evolve carries damage clamped to new max HP
    //
    // `evolve_totality_and_hp_clamp_invariant` is VACUOUS against the
    // "always heal to full" mutation because `arb_monster` pins current_hp ==
    // derived_stats.hp (full HP). This test generates a DAMAGED monster
    // (current_hp strictly below full) and asserts the EXACT clamp formula:
    //   result.current_hp == damaged_hp.min(new_derived.hp)
    // kills: always-full-heal on evolve; missing clamp; fainted-monster heal
    // ---------------------------------------------------------------------------

    /// Proptest for evolve's exact clamp semantics on damaged monsters.
    /// `damage_pct` in [0, 100] scales full HP to produce current_hp in [0, full],
    /// covering fainted (0), partially damaged, and full-HP boundaries.
    #[test]
    fn evolve_preserves_damage_clamped_to_new_max(
        source in arb_species(1),
        target in arb_species(2),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        damage_pct in 0u32..=100u32,
    ) {
        // kills: always-full-heal on evolve; missing clamp; fainted-monster heal
        let src_derived = derive_stats(&source.base_stats, &ivs, &evs, &nature, level);
        // damaged HP in [0, full]; include 0 (fainted) and full as boundaries
        let damaged_hp = (u32::from(src_derived.hp) * damage_pct / 100) as u16;
        let monster = MonsterInstance {
            species_id: source.id,
            nickname: None,
            level,
            xp: xp_for_level(level),
            ivs,
            nature,
            evs,
            bond: Bond::new(70),
            current_hp: damaged_hp,
            derived_stats: src_derived,
            party_slot: None,
        };
        let target_derived = derive_stats(&target.base_stats, &ivs, &evs, &nature, level);
        let result = evolve(&monster, &target);
        prop_assert_eq!(
            result.current_hp,
            damaged_hp.min(target_derived.hp),
            "evolve must carry damage clamped to the new max (no silent heal, no overflow)"
        );
        prop_assert!(result.current_hp <= result.derived_stats.hp);
    }

    // ---------------------------------------------------------------------------
    // Criterion 21 (A0/ADR-0147 REWRITE, T24) — Property: fuse is TOTAL and its
    // carried fields stay inside the type invariants over the WHOLE valid space.
    //
    // This is the ".expect() never fires" proof for D8's four inline bound proofs:
    // `Level::new(..).expect`, `u8::try_from(bond).expect`, `IVs::new(..).expect`
    // and `EVs::new(..).expect` are all reducer-path panics (= a wasm trap) if any
    // bound is wrong. `arb_monster`/`arb_evs` already enforce exactly the A0-5
    // preconditions (per-stat <= 252 AND total <= 510).
    //
    // The EV bounds are the ATTAINED ceilings (189 per stat, 382 total), NOT the
    // vacuous type caps (252 / 510) — an untaxed EV carry passes 252/510 but fails
    // 189/382.
    // ---------------------------------------------------------------------------

    /// Criterion 21 (T24): for arbitrary valid parents + offspring species, fuse:
    /// (a) never panics, (b) every IV <= 31, (c) 1 <= level <= 75,
    /// (d) every EV <= 189, (e) evs.total() <= 382, (f) current_hp == derived.hp,
    /// (g) current_hp > 0, (h) xp == xp_for_level(level).
    #[test]
    fn fuse_totality_and_carry_invariants(
        parent_a in arb_monster(1),
        parent_b in arb_monster(2),
        offspring in arb_species(3),
    ) {
        // kills: ANY .expect() that can fire on a valid pair (Level::new(0) when the
        //        .max(1) floor is dropped; u8::try_from overflow on the bond/level
        //        intermediates; EVs::new per-stat/total cap violation)
        // kills: the level==1 hardcode (upper bound 75 is attained, lower bound 1)
        // kills: an untaxed EV carry (per-stat <= 189 and total <= 382, NOT 252/510)
        // kills: xp desynced from the level the offspring actually ships with
        let result = fuse(&parent_a, &parent_b, &offspring, None);

        // (b) Every IV <= 31
        let all_stats = [
            StatKind::Hp,
            StatKind::Attack,
            StatKind::Defense,
            StatKind::Speed,
            StatKind::SpAttack,
            StatKind::SpDefense,
        ];
        for stat in all_stats {
            prop_assert!(
                result.ivs.get(stat) <= 31,
                "offspring IV for {:?} = {} exceeds 31",
                stat,
                result.ivs.get(stat)
            );
        }

        // (c) 1 <= level <= 75 (75 = two level-100 parents, the taxed ceiling)
        prop_assert!(
            result.level.as_u8() >= 1,
            "offspring level must be >= 1 (was {})",
            result.level.as_u8()
        );
        prop_assert!(
            result.level.as_u8() <= 75,
            "offspring level must be <= 75 — the 75%-of-average ceiling (was {})",
            result.level.as_u8()
        );

        // (d) Every EV <= 189 (the attained per-stat ceiling: avg 252 taxed to 189)
        for stat in all_stats {
            prop_assert!(
                result.evs.get(stat) <= 189,
                "offspring EV for {:?} = {} exceeds the attained taxed ceiling 189",
                stat,
                result.evs.get(stat)
            );
        }

        // (e) EV total <= 382 (sum of taxed floors; NOT the vacuous 510 budget)
        prop_assert!(
            result.evs.total() <= 382,
            "offspring evs.total() must be <= 382 (was {})",
            result.evs.total()
        );

        // (f) current_hp == derived_stats.hp (full HP at the taxed level)
        prop_assert_eq!(
            result.current_hp,
            result.derived_stats.hp,
            "offspring current_hp must equal derived_stats.hp (full HP at the taxed level)"
        );

        // (g) current_hp > 0 (derived HP with base stats >= 1 is always positive)
        prop_assert!(
            result.current_hp > 0,
            "offspring current_hp must be > 0 (derived HP with base stats >= 1)"
        );

        // (h) the level/xp pair invariant holds at the TAXED level
        prop_assert_eq!(
            result.xp,
            xp_for_level(result.level),
            "offspring xp must equal xp_for_level(offspring.level)"
        );
    }

    // ---------------------------------------------------------------------------
    // Criterion 25 (A0/ADR-0147 NEW, T25) — Property: the offspring level equals an
    // INDEPENDENT recomputation of the A0-3 formula.
    //
    // This is the ONE place in the A0 suite where mirroring the formula is allowed,
    // and the percentages are written as LITERAL 75 / 50 (never read from
    // FUSION_EFFICIENCY / LEVEL_RETENTION_FLOOR) so a constant retune still turns
    // this red alongside the hardcoded pins in transform.rs.
    // ---------------------------------------------------------------------------

    /// Criterion 25 (T25): offspring level == `max(avg*75/100, max*50/100).max(1)`
    /// over the whole valid parent-level space (1..=100 x 1..=100).
    #[test]
    fn fuse_level_matches_independent_recomputation(
        parent_a in arb_monster(1),
        parent_b in arb_monster(2),
        offspring in arb_species(3),
    ) {
        // kills: dropping either branch (avg-only / retention-floor-only),
        //        swapping 75 <-> 50, dropping .max(1), u8-width truncation of the
        //        intermediate (level 100 + 100 overflows a u8 sum)
        let la = u32::from(parent_a.level.as_u8());
        let lb = u32::from(parent_b.level.as_u8());
        let taxed_average = (la + lb) / 2 * 75 / 100;
        let retained = la.max(lb) * 50 / 100;
        let expected = taxed_average.max(retained).max(1);

        let result = fuse(&parent_a, &parent_b, &offspring, None);

        prop_assert_eq!(
            u32::from(result.level.as_u8()),
            expected,
            "offspring level must equal max(avg(a,b)*75/100, max(a,b)*50/100).max(1)"
        );
    }

    // ---------------------------------------------------------------------------
    // Criterion 22 — Property: fuse IVs per stat == max of parents
    // kills: min/avg/parent-a-only (property form of criterion 11)
    // ---------------------------------------------------------------------------

    /// Criterion 22: for arbitrary valid parents and offspring species,
    /// offspring IV per stat == max(a.iv, b.iv) for each of the six stats.
    #[test]
    fn fuse_ivs_are_per_stat_max_property(
        parent_a in arb_monster(1),
        parent_b in arb_monster(2),
        offspring in arb_species(3),
    ) {
        // kills: min(a,b) / avg(a,b) / always-a / always-b for any stat
        let result = fuse(&parent_a, &parent_b, &offspring, None);

        let all_stats = [
            StatKind::Hp,
            StatKind::Attack,
            StatKind::Defense,
            StatKind::Speed,
            StatKind::SpAttack,
            StatKind::SpDefense,
        ];
        for stat in all_stats {
            let expected = parent_a.ivs.get(stat).max(parent_b.ivs.get(stat));
            prop_assert_eq!(
                result.ivs.get(stat),
                expected,
                "offspring IV for {:?} must be max({}, {}) = {}",
                stat,
                parent_a.ivs.get(stat),
                parent_b.ivs.get(stat),
                expected
            );
        }
    }
}
