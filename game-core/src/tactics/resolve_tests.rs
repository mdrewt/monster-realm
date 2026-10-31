//! bt-2 gating tests — `tactics::resolve`: the battle model and the design §2.4 damage
//! pipeline (BT2.5), plus the resolve halves of BT2.1 (the TurnStart refresh), BT2.3 (Guard),
//! BT2.6 (First-Stand, with the exhaustive single-unit-nova simulation) and BT2.10 (the r2
//! 0-HP family on the tactical substrate).
//!
//! Every expected value is hand-derived from the plan's contracts (the A1–A19 amendments are
//! binding) and the carried `calc_damage` formula, never read back from the implementation.
//! Rolls are recomputed from `crate::tick_seed(x, 0, 0)` (the canonical splitmix64),
//! independently of `resolve::splitmix64`. Test names end in the criterion tag `_bt2_<k>`; the
//! ledger CHECKs filter on it.
//!
//! This module also owns the shared fixture builders (`pub(super)`) the other bt-2 test modules
//! import.
//!
//! # Damage fixtures
//!
//! Most battles field level-5 Water units with attack 10 that attack with Fire skills. On the
//! live chart Fire into Water is 5 (not very effective) and a Water attacker never gets STAB,
//! so with `base = (2·5/5 + 2)·P·A/D/50 + 2`:
//!
//! ```text
//! chip    Light P20 vs defence 100: 4·20·10/100/50 = 0, base 2, ×5/10 = 1, ×v/100 = 0, floor 1
//! lethal  Light P20 vs defence 1:   4·20·10/1/50 = 16, base 18, ×5/10 = 9, ×v/100 = 7..=9
//! ```
//!
//! A chip hit removes exactly 1 HP at every variance; a lethal hit removes at least 7.
//!
//! The pipeline vectors use the carried known answer (`combat/damage.rs`): a Fire level-5
//! attack-40 attacker, Fire power 40, into a Plant defence-40 target at variance 100 is base 5,
//! STAB 7, super-effective 14 — and the same skill from a Water attacker into a Wind target is
//! 5 (neutral, no STAB).

use proptest::prelude::*;

use crate::combat::ability::StatusKind;
use crate::combat::damage::calc_damage;
use crate::combat::resolve::resolve_turn;
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, Effectiveness, SideId,
    StatusEffect, TurnChoice, TurnVariance,
};
use crate::content::{load_species, SkillDef, TypeRelation};
use crate::monster::derive_stats;
use crate::monster::types::{Affinity, EVs, IVs, Level, Nature, NatureKind, StatBlock};

use super::economy::{spend, EconomyError, Entry, Tier, TurnBudget, TurnEndCause};
use super::geometry::{Cell, FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry};
use super::map::{BattleMapDef, TileDef};
use super::movement::{MoveClass, Terrain};
use super::outcome::{Adjudication, BattleEndHow};
use super::resolve::{
    can_act, damage_pipeline, deploy_unit, draw_rolls, resolve_attack, splitmix64, turn_end,
    turn_start, validate_unit, ActError, AttackOutcome, DeployError, PipelineTrace, ResolveError,
    RollPair, SkillTactics, TacticalEvent, TacticalState, TacticalUnit, TargetResult, UnitKit,
    UnitState,
};
use super::tuning::{BattleKind, TacticsTuning, TuningError};

// ===========================================================================
// Shared fixture builders
// ===========================================================================

/// Defence of a unit that takes exactly 1 from a chip hit (module doc).
pub(super) const CHIP_DEF: u16 = 100;
/// Defence of a unit that takes 7..=9 from a lethal hit (module doc).
pub(super) const LETHAL_DEF: u16 = 1;
/// A roll pair that always hits (accuracy roll 0) at the top of the variance band.
pub(super) const SURE: RollPair = RollPair {
    accuracy: 0,
    variance: 100,
};
const NVE: Option<Effectiveness> = Some(Effectiveness::NotVeryEffective);

/// The design tuning.
pub(super) fn design() -> TacticsTuning {
    TacticsTuning::DESIGN
}

/// The design tuning with one edit — the "read from `TacticsTuning`" probe.
pub(super) fn perturb(edit: impl FnOnce(&mut TacticsTuning)) -> TacticsTuning {
    let mut tuning = TacticsTuning::DESIGN;
    edit(&mut tuning);
    tuning
}

pub(super) fn c(x: u8, y: u8) -> Cell {
    Cell { x, y }
}

/// Melee: range 1, the aimed unit only, enemies only.
pub(super) fn melee() -> SkillGeometry {
    SkillGeometry {
        range_min: 1,
        range_max: 1,
        origin: Origin::TargetUnit,
        shape: Shape::Single,
        radius: 0,
        ff_filter: FfFilter::Enemies,
    }
}

/// A radius-1 diamond around the aimed unit, cast from range `1..=range_max`.
pub(super) fn diamond(ff_filter: FfFilter, range_max: u8) -> SkillGeometry {
    SkillGeometry {
        range_min: 1,
        range_max,
        origin: Origin::TargetUnit,
        shape: Shape::Diamond,
        radius: 1,
        ff_filter,
    }
}

/// The ring around the caster (radius-1 burst, aim = the caster's own tile).
fn ring(ff_filter: FfFilter) -> SkillGeometry {
    SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Burst,
        radius: 1,
        ff_filter,
    }
}

/// A Light skill: power 20, accuracy 100, no status.
pub(super) fn light(skill_id: u32, affinity: Affinity, geometry: SkillGeometry) -> SkillTactics {
    SkillTactics {
        skill_id,
        tier: Tier::Light,
        affinity,
        power: 20,
        accuracy: 100,
        applies_status: None,
        geometry,
    }
}

/// A Heavy skill of `power`, accuracy 100, no status.
pub(super) fn heavy(
    skill_id: u32,
    affinity: Affinity,
    power: u16,
    geometry: SkillGeometry,
) -> SkillTactics {
    SkillTactics {
        tier: Tier::Heavy,
        power,
        ..light(skill_id, affinity, geometry)
    }
}

/// Fire power 40, accuracy 100, melee (the carried known-answer skill).
pub(super) fn fire40() -> SkillTactics {
    SkillTactics {
        power: 40,
        ..light(9, Affinity::Fire, melee())
    }
}

pub(super) fn stat_block(hp: u16, attack: u16, defense: u16, speed: u16) -> StatBlock {
    StatBlock {
        hp,
        attack,
        defense,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

pub(super) fn kit(
    species_id: u32,
    affinity: Affinity,
    level: u8,
    stats: StatBlock,
    base_speed: u16,
    class: MoveClass,
    skills: Vec<SkillTactics>,
) -> UnitKit {
    UnitKit {
        species_id,
        affinity,
        level,
        stats,
        base_speed,
        class,
        skills,
    }
}

/// A level-5 Water unit with attack 10; `speed` is both its levelled and its base speed.
pub(super) fn water(max_hp: u16, defense: u16, speed: u16, skills: Vec<SkillTactics>) -> UnitKit {
    kit(
        1,
        Affinity::Water,
        5,
        stat_block(max_hp, 10, defense, speed),
        speed,
        MoveClass::Walk,
        skills,
    )
}

/// `deploy_unit(..)`, unwrapped (every fixture unit is valid).
pub(super) fn unit(
    id: u32,
    side: Side,
    slot: u8,
    pos: Cell,
    kit: UnitKit,
    cur_hp: u16,
) -> TacticalUnit {
    deploy_unit(id, side, slot, pos, kit, cur_hp).expect("fixture units deploy")
}

/// The Fire level-5 attack-40 attacker of the carried known answer (100/100 HP).
pub(super) fn fire_attacker() -> TacticalUnit {
    unit(
        1,
        Side::A,
        0,
        c(0, 0),
        kit(
            1,
            Affinity::Fire,
            5,
            stat_block(100, 40, 40, 50),
            50,
            MoveClass::Walk,
            vec![],
        ),
        100,
    )
}

/// A Plant defence-40 target of 100 max HP at `cur_hp`: `fire40` from `fire_attacker` at
/// variance 100 is d0 = 14.
pub(super) fn plant_target(cur_hp: u16) -> TacticalUnit {
    unit(
        2,
        Side::B,
        0,
        c(1, 0),
        kit(
            2,
            Affinity::Plant,
            5,
            stat_block(100, 40, 40, 50),
            50,
            MoveClass::Walk,
            vec![],
        ),
        cur_hp,
    )
}

/// A Water level-5 attack-40 attacker: `fire40` from it into `wind_target` is d0 = 5.
pub(super) fn water_attacker() -> TacticalUnit {
    unit(
        1,
        Side::A,
        0,
        c(0, 0),
        kit(
            1,
            Affinity::Water,
            5,
            stat_block(100, 40, 40, 50),
            50,
            MoveClass::Walk,
            vec![],
        ),
        100,
    )
}

/// A Wind defence-40 target of 100 max HP at `cur_hp`.
pub(super) fn wind_target(cur_hp: u16) -> TacticalUnit {
    unit(
        2,
        Side::B,
        0,
        c(1, 0),
        kit(
            2,
            Affinity::Wind,
            5,
            stat_block(100, 40, 40, 50),
            50,
            MoveClass::Walk,
            vec![],
        ),
        cur_hp,
    )
}

/// A valid 7×7 all-Plain map (spawns 6 apart, all Walk-connected).
pub(super) fn open_map() -> BattleMapDef {
    BattleMapDef {
        width: 7,
        height: 7,
        tiles: vec![
            TileDef {
                terrain: Terrain::Plain,
                elevation: 0,
                blocks_los: false,
            };
            49
        ],
        spawn_a: vec![c(0, 0), c(0, 2), c(0, 4)],
        spawn_b: vec![c(6, 0), c(6, 2), c(6, 4)],
    }
}

/// `TacticalState::new` on the open map, unwrapped.
pub(super) fn state(kind: BattleKind, seed: u64, units: Vec<TacticalUnit>) -> TacticalState {
    TacticalState::new(kind, seed, &open_map(), units).expect("fixture battles are valid")
}

/// A 1v1: A's unit 1 (speed 50, skill 10 = melee Light) at (2,3) faces B's unit 2 (speed 40,
/// skill 20 = melee Light) at (3,3); both chip defence, 100/100 HP.
pub(super) fn duel(kind: BattleKind, seed: u64) -> TacticalState {
    state(
        kind,
        seed,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(100, CHIP_DEF, 50, vec![light(10, Affinity::Fire, melee())]),
                100,
            ),
            unit(
                2,
                Side::B,
                0,
                c(3, 3),
                water(100, CHIP_DEF, 40, vec![light(20, Affinity::Fire, melee())]),
                100,
            ),
        ],
    )
}

/// A started 1v1 plus a reserve: A's unit 1 (carrying `skill`, which must be skill 10) at
/// (2,3) faces B's unit 2 (`target` at `target_hp`) at (3,3); B's unit 3 waits out of reach at
/// (6,6) so a KO of unit 2 does not end the battle. Unit 1 has had its TurnStart.
fn versus(skill: SkillTactics, target: UnitKit, target_hp: u16) -> TacticalState {
    let mut st = state(
        BattleKind::Pvp,
        21,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(100, CHIP_DEF, 50, vec![skill]),
                100,
            ),
            unit(2, Side::B, 0, c(3, 3), target, target_hp),
            unit(
                3,
                Side::B,
                1,
                c(6, 6),
                water(100, CHIP_DEF, 10, vec![]),
                100,
            ),
        ],
    );
    ready(&mut st, 1);
    st
}

/// Unit 1 uses skill 10 on (3,3), unwrapped.
fn strike(st: &mut TacticalState, chart: &TypeChart) -> AttackOutcome {
    resolve_attack(st, 1, 10, c(3, 3), chart, &design()).expect("a valid attack entry")
}

pub(super) fn unit_of(st: &TacticalState, id: u32) -> &TacticalUnit {
    st.unit(id).expect("the unit exists")
}

/// TurnStart at the design tuning, unwrapped.
pub(super) fn ready(st: &mut TacticalState, id: u32) {
    turn_start(st, id, &design()).expect("the unit can start its turn");
}

/// The live (embedded) type chart.
pub(super) fn chart() -> TypeChart {
    make_type_chart()
}

/// A hand-built chart where Fire into Water is immune (the live chart has no immune pair).
pub(super) fn immune_chart() -> TypeChart {
    TypeChart::new(&[TypeRelation {
        attacker: Affinity::Fire,
        defender: Affinity::Water,
        effectiveness: 0,
    }])
}

/// The canonical splitmix64 — the oracle for every roll and coin.
pub(super) fn mix(x: u64) -> u64 {
    crate::tick_seed(x, 0, 0)
}

/// The side a coin over `x` names: low bit 0 → A, 1 → B.
pub(super) fn coin(x: u64) -> Side {
    if (mix(x) & 1) == 0 {
        Side::A
    } else {
        Side::B
    }
}

/// The (accuracy, variance) pair the private stream yields at `seq`.
pub(super) fn rolls_at(seed: u64, seq: u64) -> RollPair {
    RollPair {
        accuracy: (mix(seed ^ seq) % 100) as u8,
        variance: 85 + (mix(seed ^ seq.wrapping_add(1)) % 16) as u8,
    }
}

fn executed_results(out: &AttackOutcome) -> &[TargetResult] {
    match out.events.first() {
        Some(TacticalEvent::Executed { results, .. }) => results.as_slice(),
        other => panic!("an attack's first event is Executed, got {other:?}"),
    }
}

// ===========================================================================
// BT2.5 — the roll stream
// ===========================================================================

/// BT2.5: `splitmix64(x)` is the canonical splitmix64 output for state `x`
/// (`tick_seed(x, 0, 0)`): `splitmix64(0)` = 0xE220_A839_7B1D_CDAF, `splitmix64(1)` =
/// 0x910A_2DEC_8902_5CC1 (the published seed-1 first output), `splitmix64(6)` =
/// 0xBD64_A5D9_ADEF_E000 (`tick_seed(1, 2, 3)`).
/// Kills: a hand-rolled mix with a wrong constant or shift; a state off by one gamma.
#[test]
fn splitmix64_is_the_canonical_splitmix_output_bt2_5() {
    assert_eq!(splitmix64(0), 0xE220_A839_7B1D_CDAF);
    assert_eq!(splitmix64(1), 0x910A_2DEC_8902_5CC1);
    assert_eq!(splitmix64(6), 0xBD64_A5D9_ADEF_E000);
    for x in [0u64, 1, 6, 0x5EED, 0xDEAD_BEEF, 1 << 53, u64::MAX] {
        assert_eq!(splitmix64(x), crate::tick_seed(x, 0, 0), "x = {x:#x}");
    }
}

/// BT2.5: `draw_rolls` takes accuracy = `splitmix64(seed ^ seq) % 100` FIRST, then variance =
/// `85 + splitmix64(seed ^ (seq + 1)) % 16`, and advances `action_seq` by 2; consecutive pairs
/// continue the stream. Hand vectors: seed 0 / seq 0 is (35, 86) — 0x…CDAF mod 100 = 35, then
/// 0x…5CC1 mod 16 = 1 — and seed 7 / seq 6 is (65, 100) — splitmix64(1) mod 100 = 65, then
/// splitmix64(0) mod 16 = 15.
/// Kills: the two draws swapped; `seed + seq` for `seed ^ seq`; one draw per pair; a seq that
/// does not advance.
#[test]
fn draw_rolls_reads_accuracy_then_variance_and_advances_by_two_bt2_5() {
    let mut st = duel(BattleKind::Pvp, 0);
    for (seed, seq) in [
        (0u64, 0u64),
        (0xDEAD_BEEF, 0x0F0F),
        (0x5EED, 41),
        (12_345, 6),
    ] {
        st.seed = seed;
        st.action_seq = seq;
        let want = RollPair {
            accuracy: (mix(seed ^ seq) % 100) as u8,
            variance: 85 + (mix(seed ^ (seq + 1)) % 16) as u8,
        };
        assert_eq!(draw_rolls(&mut st), want, "seed {seed:#x} seq {seq}");
        assert_eq!(st.action_seq, seq + 2);
        assert_eq!(
            draw_rolls(&mut st),
            rolls_at(seed, seq + 2),
            "the next pair"
        );
        assert_eq!(st.action_seq, seq + 4);
    }
    st.seed = 0;
    st.action_seq = 0;
    assert_eq!(
        draw_rolls(&mut st),
        RollPair {
            accuracy: 35,
            variance: 86
        }
    );
    st.seed = 7;
    st.action_seq = 6;
    assert_eq!(
        draw_rolls(&mut st),
        RollPair {
            accuracy: 65,
            variance: 100
        }
    );
}

/// BT2.5 (plan A12): `action_seq` wraps at `u64::MAX` — the variance draw uses seq 0 — with
/// no overflow panic.
/// Kills: a plain `+= 1` (overflow panic in debug).
#[test]
fn draw_rolls_wraps_action_seq_at_u64_max_bt2_5() {
    let mut st = duel(BattleKind::Pvp, 0xABCD);
    st.action_seq = u64::MAX;
    assert_eq!(
        draw_rolls(&mut st),
        RollPair {
            accuracy: (mix(0xABCD ^ u64::MAX) % 100) as u8,
            variance: 85 + (mix(0xABCD) % 16) as u8,
        }
    );
    assert_eq!(st.action_seq, 1);
}

// ===========================================================================
// BT2.5 — the pipeline
// ===========================================================================

/// BT2.5: hit = the carried `accuracy_check(accuracy, roll)` — accuracy 90 hits on 89 and
/// misses on 90; accuracy 100 hits every roll 0..=99.
/// Kills: `<=` for `<`; the roll read as `100 - roll`; accuracy ignored.
#[test]
fn accuracy_ninety_hits_on_roll_eighty_nine_and_misses_on_ninety_bt2_5() {
    let attacker = fire_attacker();
    let target = plant_target(100);
    let ninety = SkillTactics {
        accuracy: 90,
        ..fire40()
    };
    let sure = fire40();
    let ch = chart();
    let tu = design();
    let roll = |accuracy: u8| RollPair {
        accuracy,
        variance: 100,
    };
    assert!(damage_pipeline(&attacker, &target, &ninety, &ch, false, roll(89), &tu).hit);
    assert!(!damage_pipeline(&attacker, &target, &ninety, &ch, false, roll(90), &tu).hit);
    assert!(!damage_pipeline(&attacker, &target, &ninety, &ch, false, roll(99), &tu).hit);
    assert!(damage_pipeline(&attacker, &target, &ninety, &ch, false, roll(0), &tu).hit);
    for r in 0..100u8 {
        assert!(
            damage_pipeline(&attacker, &target, &sure, &ch, false, roll(r), &tu).hit,
            "accuracy 100, roll {r}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// BT2.5: `d0` is the carried `calc_damage` (weather None) over the same level, attack,
    /// defence, power, affinities and variance, with the same effectiveness; with no flank and
    /// no Guard `d1 = d2 = d3 = d0` (the live chart has no immune pair and `calc_damage`
    /// already floors at 1).
    /// Kills: a re-implemented damage formula; a dropped STAB, type or variance term; weather.
    #[test]
    fn the_pipelines_d0_is_the_carried_calc_damage_bt2_5(
        level in 1u8..=100,
        attack in 1u16..=255,
        defense in 1u16..=255,
        power in 1u16..=150,
        variance in 85u8..=100,
        att_aff in 0usize..8,
        def_aff in 0usize..8,
        skill_aff in 0usize..8,
    ) {
        let (att_affinity, def_affinity, skill_affinity) =
            (Affinity::ALL[att_aff], Affinity::ALL[def_aff], Affinity::ALL[skill_aff]);
        let att_stats = stat_block(100, attack, 40, 50);
        let def_stats = stat_block(100, 40, defense, 50);
        let attacker = unit(
            1, Side::A, 0, c(0, 0),
            kit(1, att_affinity, level, att_stats, 50, MoveClass::Walk, vec![]),
            100,
        );
        let target = unit(
            2, Side::B, 0, c(1, 0),
            kit(2, def_affinity, level, def_stats, 50, MoveClass::Walk, vec![]),
            100,
        );
        let skill = SkillTactics { power, ..light(9, skill_affinity, melee()) };
        let ch = chart();
        let trace = damage_pipeline(
            &attacker, &target, &skill, &ch, false, RollPair { accuracy: 0, variance }, &design(),
        );
        let monster = |species_id: u32, affinity: Affinity, stats: StatBlock| BattleMonster {
            species_id,
            affinity,
            level,
            current_hp: 100,
            max_hp: 100,
            stats,
            known_skill_ids: vec![],
            status: None,
        };
        let skill_def = SkillDef {
            id: 9,
            name: String::new(),
            affinity: skill_affinity,
            power,
            accuracy: 100,
            pp: 0,
            sets_weather: None,
            applies_status: None,
        };
        let (d0, eff) = calc_damage(
            &monster(1, att_affinity, att_stats),
            &monster(2, def_affinity, def_stats),
            &skill_def,
            &ch,
            variance,
            None,
        );
        prop_assert!(trace.hit);
        prop_assert_eq!(trace.effectiveness, Some(eff));
        prop_assert_eq!((trace.d0, trace.d1, trace.d2, trace.d3), (d0, d0, d0, d0));
    }
}

/// BT2.5: the pinned order is flank ×5/4 THEN Guard ×3/4, flooring at each step. d0 5 flanked
/// and guarded is 6 then 4 (Guard first would be 3 then 3); flank alone 6; Guard alone 3; the
/// STAB super-effective d0 14 flanked and guarded is 17 then 12.
/// Kills: Guard before flank; one combined ×15/16 multiply; a missing floor between the steps.
#[test]
fn the_pipeline_flanks_then_guards_flooring_each_step_bt2_5() {
    let ch = chart();
    let tu = design();
    let attacker = water_attacker();
    let mut target = wind_target(100);
    target.guard = true;
    assert_eq!(
        damage_pipeline(&attacker, &target, &fire40(), &ch, true, SURE, &tu),
        PipelineTrace {
            hit: true,
            d0: 5,
            d1: 6,
            d2: 4,
            d3: 4,
            effectiveness: Some(Effectiveness::Neutral),
            applied: 4,
            hp_after: 96,
            stood_ground: false,
        }
    );
    let guard_only = damage_pipeline(&attacker, &target, &fire40(), &ch, false, SURE, &tu);
    assert_eq!(
        (guard_only.d0, guard_only.d1, guard_only.d2, guard_only.d3),
        (5, 5, 3, 3)
    );
    target.guard = false;
    let flank_only = damage_pipeline(&attacker, &target, &fire40(), &ch, true, SURE, &tu);
    assert_eq!(
        (flank_only.d0, flank_only.d1, flank_only.d2, flank_only.d3),
        (5, 6, 6, 6)
    );
    let mut plant = plant_target(100);
    plant.guard = true;
    let both = damage_pipeline(&fire_attacker(), &plant, &fire40(), &ch, true, SURE, &tu);
    assert_eq!((both.d0, both.d1, both.d2, both.d3), (14, 17, 12, 12));
    assert_eq!(both.effectiveness, Some(Effectiveness::SuperEffective));
}

/// BT2.5: an immune hit is 0 at every step — flanked, Guarded and against a First-Stand target
/// at 3 HP — with no save and HP unchanged (the native-only immune chart).
/// Kills: `max(d, 1)` applied to an immune hit; First-Stand firing on 0 ≥ hp; Guard's min 1
/// lifting 0.
#[test]
fn an_immune_hit_is_zero_even_flanked_guarded_and_first_stand_bt2_5() {
    let attacker = unit(
        1,
        Side::A,
        0,
        c(0, 0),
        kit(
            1,
            Affinity::Fire,
            50,
            stat_block(200, 200, 40, 50),
            50,
            MoveClass::Walk,
            vec![],
        ),
        200,
    );
    let mut target = unit(2, Side::B, 0, c(1, 0), water(10, LETHAL_DEF, 40, vec![]), 3);
    target.guard = true;
    assert!(target.first_stand);
    let trace = damage_pipeline(
        &attacker,
        &target,
        &heavy(9, Affinity::Fire, 75, melee()),
        &immune_chart(),
        true,
        SURE,
        &design(),
    );
    assert_eq!(
        trace,
        PipelineTrace {
            hit: true,
            d0: 0,
            d1: 0,
            d2: 0,
            d3: 0,
            effectiveness: Some(Effectiveness::Immune),
            applied: 0,
            hp_after: 3,
            stood_ground: false,
        }
    );
}

/// BT2.5: through `resolve_attack` an immune hit removes nothing, applies no status (the skill
/// Burns), emits no StoodGround and keeps the target's First-Stand flag; AP is still spent.
/// Kills: a status applied on an immune hit; a StoodGround or a cleared flag on 0 damage.
#[test]
fn an_immune_hit_removes_nothing_applies_nothing_and_keeps_first_stand_bt2_5() {
    let burn = SkillTactics {
        applies_status: Some(StatusKind::Burn),
        ..light(10, Affinity::Fire, melee())
    };
    let mut st = versus(burn, water(5, LETHAL_DEF, 40, vec![]), 5);
    let out = strike(&mut st, &immune_chart());
    assert_eq!(out.ap_spent, 2);
    assert_eq!(out.events.len(), 1, "Executed only: {:?}", out.events);
    let results = executed_results(&out);
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(
        (r.unit, r.hit, r.damage, r.effectiveness, r.ko),
        (2, true, 0, Some(Effectiveness::Immune), false)
    );
    let target = unit_of(&st, 2);
    assert_eq!(
        (
            target.cur_hp,
            target.status,
            target.first_stand,
            target.state
        ),
        (5, None, true, UnitState::Active)
    );
    assert_eq!(st.attack_damage_dealt, [0, 0]);
}

/// BT2.5: a miss is a zero trace — no damage at any step, no effectiveness, no save, HP
/// unchanged — even when flanked against a Guarded First-Stand target.
/// Kills: damage computed on a miss; a flank/guard step run on a miss.
#[test]
fn a_missed_roll_is_an_all_zero_trace_with_hp_unchanged_bt2_5() {
    let mut target = plant_target(50);
    target.guard = true;
    let ninety = SkillTactics {
        accuracy: 90,
        ..fire40()
    };
    let trace = damage_pipeline(
        &fire_attacker(),
        &target,
        &ninety,
        &chart(),
        true,
        RollPair {
            accuracy: 95,
            variance: 100,
        },
        &design(),
    );
    assert_eq!(
        trace,
        PipelineTrace {
            hit: false,
            d0: 0,
            d1: 0,
            d2: 0,
            d3: 0,
            effectiveness: None,
            applied: 0,
            hp_after: 50,
            stood_ground: false,
        }
    );
}

// ===========================================================================
// BT2.5 — resolve_attack
// ===========================================================================

/// BT2.5: a miss is an executed action — its AP is spent, it counts as an attack (the next
/// Light pays Exert), it applies no status (the skill Poisons), it emits `Missed`, both rolls
/// are drawn, and the target's HP and First-Stand are untouched.
/// Kills: a refunded miss; a miss that does not count toward Exert; a status on a miss; no
/// Missed event; a miss that draws only its accuracy roll.
#[test]
fn a_miss_spends_its_ap_counts_as_an_attack_and_emits_missed_bt2_5() {
    let never = SkillTactics {
        accuracy: 0,
        applies_status: Some(StatusKind::Poison),
        ..light(10, Affinity::Fire, melee())
    };
    let mut st = versus(never, water(100, CHIP_DEF, 40, vec![]), 100);
    let seq = st.action_seq;
    let out = strike(&mut st, &chart());
    assert_eq!(
        out,
        AttackOutcome {
            events: vec![
                TacticalEvent::Executed {
                    attacker: 1,
                    skill_id: 10,
                    results: vec![TargetResult {
                        unit: 2,
                        hit: false,
                        damage: 0,
                        effectiveness: None,
                        flank: false,
                        guard: false,
                        ko: false,
                    }],
                },
                TacticalEvent::Missed {
                    attacker: 1,
                    target: 2,
                },
            ],
            ap_spent: 2,
        }
    );
    assert_eq!(
        unit_of(&st, 1).budget,
        TurnBudget {
            ap: 4,
            strides_used: 0,
            attacks: 1,
            last: Some(Entry::Attack(Tier::Light)),
        }
    );
    let target = unit_of(&st, 2);
    assert_eq!(
        (target.cur_hp, target.status, target.first_stand),
        (100, None, true)
    );
    assert_eq!(st.action_seq, seq + 2);
    assert_eq!(st.attack_damage_dealt, [0, 0]);
    assert_eq!(
        strike(&mut st, &chart()).ap_spent,
        4,
        "the miss counted for Exert"
    );
}

/// BT2.5: an AoE draws accuracy then variance for EACH target, in `target_set` order — (y, x,
/// id): 5 at (2,3), 4 at (3,3), 3 at (4,3), the reverse of id order — two draws per target.
/// Accuracy 50 exposes each target's own roll (the seed is chosen so the first and third
/// targets disagree) and lethal defence exposes its variance (damage = 9·v/100).
/// Kills: one roll pair shared by every target; rolls assigned in id order; one draw per
/// target; rolls taken in units order.
#[test]
fn an_aoe_draws_accuracy_and_variance_per_target_in_target_order_bt2_5() {
    let coin_flip = SkillTactics {
        accuracy: 50,
        ..light(10, Affinity::Fire, diamond(FfFilter::Enemies, 2))
    };
    let seed = (0u64..)
        .find(|&s| (rolls_at(s, 0).accuracy < 50) != (rolls_at(s, 4).accuracy < 50))
        .expect("a seed whose first and third targets disagree");
    let mut st = state(
        BattleKind::Pvp,
        seed,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 1),
                water(100, CHIP_DEF, 50, vec![coin_flip]),
                100,
            ),
            unit(
                3,
                Side::B,
                0,
                c(4, 3),
                water(50, LETHAL_DEF, 40, vec![]),
                50,
            ),
            unit(
                4,
                Side::B,
                1,
                c(3, 3),
                water(50, LETHAL_DEF, 30, vec![]),
                50,
            ),
            unit(
                5,
                Side::B,
                2,
                c(2, 3),
                water(50, LETHAL_DEF, 20, vec![]),
                50,
            ),
        ],
    );
    ready(&mut st, 1);
    let seq0 = st.action_seq;
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid AoE");
    let want: Vec<TargetResult> = [5u32, 4, 3]
        .into_iter()
        .enumerate()
        .map(|(i, id)| {
            let r = rolls_at(seed, seq0 + 2 * i as u64);
            let hit = r.accuracy < 50;
            TargetResult {
                unit: id,
                hit,
                damage: if hit {
                    9 * u16::from(r.variance) / 100
                } else {
                    0
                },
                effectiveness: hit.then_some(Effectiveness::NotVeryEffective),
                flank: false,
                guard: false,
                ko: false,
            }
        })
        .collect();
    assert_eq!(executed_results(&out), want.as_slice());
    assert_eq!(st.action_seq, seq0 + 6);
    for w in &want {
        assert_eq!(
            unit_of(&st, w.unit).cur_hp,
            50 - w.damage,
            "unit {}",
            w.unit
        );
    }
    let missed: Vec<u32> = out
        .events
        .iter()
        .filter_map(|e| match e {
            TacticalEvent::Missed { target, .. } => Some(*target),
            _ => None,
        })
        .collect();
    let want_missed: Vec<u32> = want.iter().filter(|w| !w.hit).map(|w| w.unit).collect();
    assert_eq!(missed, want_missed);
}

/// BT2.5 (plan A7): an empty target set is a valid attack — AP spent, the attack counted, no
/// rolls drawn, `Executed { results: [] }` and nothing else.
/// Kills: an empty AoE rejected or refunded; rolls drawn with no target.
#[test]
fn an_attack_with_no_targets_spends_its_ap_and_draws_nothing_bt2_5() {
    let mut st = state(
        BattleKind::Pvp,
        3,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(1, 1),
                water(
                    100,
                    CHIP_DEF,
                    50,
                    vec![light(10, Affinity::Fire, ring(FfFilter::Enemies))],
                ),
                100,
            ),
            unit(
                2,
                Side::B,
                0,
                c(5, 5),
                water(100, CHIP_DEF, 40, vec![]),
                100,
            ),
        ],
    );
    ready(&mut st, 1);
    let seq = st.action_seq;
    assert_eq!(
        resolve_attack(&mut st, 1, 10, c(1, 1), &chart(), &design()),
        Ok(AttackOutcome {
            events: vec![TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![],
            }],
            ap_spent: 2,
        })
    );
    assert_eq!(st.action_seq, seq);
    assert_eq!(
        unit_of(&st, 1).budget,
        TurnBudget {
            ap: 4,
            strides_used: 0,
            attacks: 1,
            last: Some(Entry::Attack(Tier::Light)),
        }
    );
    assert_eq!(unit_of(&st, 2).cur_hp, 100);
}

fn assert_rejected(
    mut st: TacticalState,
    attacker: u32,
    skill_id: u32,
    aim: Cell,
    want: ResolveError,
) {
    let before = st.clone();
    assert_eq!(
        resolve_attack(&mut st, attacker, skill_id, aim, &chart(), &design()),
        Err(want)
    );
    assert_eq!(st, before, "{want:?} must leave the battle byte-identical");
}

/// BT2.5: every invalid entry (`Act`, `UnknownSkill`, `Geometry`, `Economy`) is refused with
/// the state `==` before — 0 AP, no rolls drawn, nothing moved — and the checks run in order:
/// can-act, skill in kit, geometry, affordability.
/// Kills: AP or rolls taken before validation finishes; a check order that reports the wrong
/// error; another unit's skill accepted.
#[test]
fn an_invalid_attack_entry_changes_nothing_and_draws_nothing_bt2_5() {
    let started = || {
        let mut st = duel(BattleKind::Pvp, 5);
        ready(&mut st, 1);
        st
    };
    let fainted = || {
        let mut st = started();
        let u = st.unit_mut(1).expect("unit 1");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
        st
    };
    assert_rejected(
        started(),
        99,
        10,
        c(3, 3),
        ResolveError::Act(ActError::UnknownUnit(99)),
    );
    assert_rejected(
        fainted(),
        1,
        10,
        c(3, 3),
        ResolveError::Act(ActError::Fainted(1)),
    );
    let mut over = started();
    over.outcome = BattleOutcome::SideBWins;
    assert_rejected(
        over,
        1,
        10,
        c(3, 3),
        ResolveError::Act(ActError::BattleOver),
    );
    assert_rejected(
        started(),
        1,
        99,
        c(3, 3),
        ResolveError::UnknownSkill {
            unit: 1,
            skill_id: 99,
        },
    );
    assert_rejected(
        started(),
        1,
        20,
        c(3, 3),
        ResolveError::UnknownSkill {
            unit: 1,
            skill_id: 20,
        },
    );
    assert_rejected(
        started(),
        1,
        10,
        c(5, 3),
        ResolveError::Geometry(GeometryError::OutOfRange { distance: 3 }),
    );
    assert_rejected(
        started(),
        1,
        10,
        c(2, 2),
        ResolveError::Geometry(GeometryError::NoTargetUnit),
    );
    assert_rejected(
        started(),
        1,
        10,
        c(9, 9),
        ResolveError::Geometry(GeometryError::OutOfBounds),
    );
    assert_rejected(
        duel(BattleKind::Pvp, 5),
        1,
        10,
        c(3, 3),
        ResolveError::Economy(EconomyError::Unaffordable { cost: 2, ap: 0 }),
    );
    let mut poor = started();
    poor.unit_mut(1).expect("unit 1").budget.ap = 1;
    assert_rejected(
        poor,
        1,
        10,
        c(3, 3),
        ResolveError::Economy(EconomyError::Unaffordable { cost: 2, ap: 1 }),
    );
    // First failure wins: can-act → skill → geometry → economy.
    assert_rejected(
        fainted(),
        1,
        99,
        c(9, 9),
        ResolveError::Act(ActError::Fainted(1)),
    );
    assert_rejected(
        started(),
        1,
        99,
        c(9, 9),
        ResolveError::UnknownSkill {
            unit: 1,
            skill_id: 99,
        },
    );
    assert_rejected(
        duel(BattleKind::Pvp, 5),
        1,
        10,
        c(9, 9),
        ResolveError::Geometry(GeometryError::OutOfBounds),
    );
}

/// BT2.5: the events are `Executed` first, then each target's detail events in target order
/// (StoodGround before StatusApplied within a target), then the sweep's. A's 1 at (3,1) Lights
/// a diamond around (3,3) with a Burn: 6 at (3,2) (lethal, First-Stand → saved at 1 HP, then
/// Burned), 5 at (3,3) (chip → Burned), 4 at (4,3) (lethal, activated, queued → KO'd, no
/// status, its plan voided).
/// Kills: details grouped by kind instead of by target; the sweep's Ko before the details;
/// Executed last; a status on a KO'd target.
#[test]
fn executed_comes_first_then_each_targets_details_then_the_sweep_bt2_5() {
    let burn = SkillTactics {
        applies_status: Some(StatusKind::Burn),
        ..light(10, Affinity::Fire, diamond(FfFilter::Enemies, 2))
    };
    let mut st = state(
        BattleKind::Pvp,
        11,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 1),
                water(100, CHIP_DEF, 50, vec![burn]),
                100,
            ),
            unit(4, Side::B, 0, c(4, 3), water(5, LETHAL_DEF, 40, vec![]), 5),
            unit(
                5,
                Side::B,
                1,
                c(3, 3),
                water(100, CHIP_DEF, 30, vec![]),
                100,
            ),
            unit(6, Side::B, 2, c(3, 2), water(5, LETHAL_DEF, 20, vec![]), 5),
        ],
    );
    st.unit_mut(4).expect("unit 4").first_stand = false;
    st.queued = vec![4];
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid AoE");
    let hit = |unit: u32, damage: u16, ko: bool| TargetResult {
        unit,
        hit: true,
        damage,
        effectiveness: NVE,
        flank: false,
        guard: false,
        ko,
    };
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![hit(6, 4, false), hit(5, 1, false), hit(4, 5, true)],
            },
            TacticalEvent::StoodGround { unit: 6 },
            TacticalEvent::StatusApplied {
                unit: 6,
                status: StatusEffect::Burn,
            },
            TacticalEvent::StatusApplied {
                unit: 5,
                status: StatusEffect::Burn,
            },
            TacticalEvent::Ko { unit: 4 },
            TacticalEvent::QueueVoided { unit: 4 },
        ]
    );
    assert_eq!(st.attack_damage_dealt, [10, 0]);
}

/// BT2.5 (plan A7): `TargetResult.damage` is the HP actually removed — a First-Stand save from
/// 6 HP reports 5 (not the pipeline's 7..=9) and a KO from 3 HP reports 3 — and that is what
/// `attack_damage_dealt` accumulates.
/// Kills: `damage = d3`; the tally fed from d3.
#[test]
fn a_target_results_damage_is_the_hp_actually_removed_bt2_5() {
    let mut saved = versus(
        light(10, Affinity::Fire, melee()),
        water(6, LETHAL_DEF, 40, vec![]),
        6,
    );
    let out = strike(&mut saved, &chart());
    let r = &executed_results(&out)[0];
    assert_eq!((r.damage, r.ko), (5, false));
    assert_eq!(saved.attack_damage_dealt, [5, 0]);

    let mut kod = versus(
        light(10, Affinity::Fire, melee()),
        water(3, LETHAL_DEF, 40, vec![]),
        3,
    );
    kod.unit_mut(2).expect("unit 2").first_stand = false;
    let out = strike(&mut kod, &chart());
    let r = &executed_results(&out)[0];
    assert_eq!((r.damage, r.ko), (3, true));
    assert_eq!(kod.attack_damage_dealt, [3, 0]);
}

/// BT2.5 (plan A7): `attack_damage_dealt[attacker side]` counts enemy targets only — an
/// All-filter splash that also hits an ally adds nothing for the ally — and each side keeps
/// its own tally.
/// Kills: friendly fire counted toward adjudication; the tally indexed by the target's side.
#[test]
fn attack_damage_dealt_counts_enemy_targets_only_bt2_5() {
    let splash = light(10, Affinity::Fire, diamond(FfFilter::All, 2));
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 1),
                water(100, CHIP_DEF, 50, vec![splash]),
                100,
            ),
            unit(
                4,
                Side::A,
                1,
                c(2, 3),
                water(100, CHIP_DEF, 30, vec![]),
                100,
            ),
            unit(
                2,
                Side::B,
                0,
                c(3, 3),
                water(100, CHIP_DEF, 40, vec![light(20, Affinity::Fire, melee())]),
                100,
            ),
        ],
    );
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid AoE");
    let hits: Vec<(u32, u16)> = executed_results(&out)
        .iter()
        .map(|r| (r.unit, r.damage))
        .collect();
    assert_eq!(hits, vec![(4, 1), (2, 1)]);
    assert_eq!(st.attack_damage_dealt, [1, 0]);
    ready(&mut st, 2);
    resolve_attack(&mut st, 2, 20, c(2, 3), &chart(), &design()).expect("B answers into A's 4");
    assert_eq!(st.attack_damage_dealt, [1, 1]);
}

/// BT2.5 (judgement 9): flank is judged on the board as it stood BEFORE the attack. A's 1 at
/// (3,0) splashes everything within 1 of B's 8 at (3,3); A's 2 at (3,2) and 3 at (3,4) pin 8.
/// Unit 2 (1 HP, activated) is processed first and dies to the chip; 8 is still flanked.
/// Kills: flank re-evaluated on the live board after earlier targets fell; flank never set.
#[test]
fn flank_is_judged_on_the_board_before_the_attack_bt2_5() {
    let splash = light(10, Affinity::Fire, diamond(FfFilter::All, 3));
    let mut st = state(
        BattleKind::Pvp,
        8,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 0),
                water(100, CHIP_DEF, 50, vec![splash]),
                100,
            ),
            unit(2, Side::A, 1, c(3, 2), water(100, CHIP_DEF, 30, vec![]), 1),
            unit(
                3,
                Side::A,
                2,
                c(3, 4),
                water(100, CHIP_DEF, 20, vec![]),
                100,
            ),
            unit(
                8,
                Side::B,
                0,
                c(3, 3),
                water(100, CHIP_DEF, 40, vec![]),
                100,
            ),
        ],
    );
    st.unit_mut(2).expect("unit 2").first_stand = false;
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid AoE");
    let hit = |unit: u32, flank: bool, ko: bool| TargetResult {
        unit,
        hit: true,
        damage: 1,
        effectiveness: NVE,
        flank,
        guard: false,
        ko,
    };
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![
                    hit(2, false, true),
                    hit(8, true, false),
                    hit(3, false, false)
                ],
            },
            TacticalEvent::Ko { unit: 2 },
        ]
    );
}

/// The status unit 2 ends with after unit 1's attack with `skill` (skill 10) on it, and the
/// attack's events. `prior` is its status before; `activated` clears its First-Stand.
fn status_after(
    skill: SkillTactics,
    target: UnitKit,
    target_hp: u16,
    prior: Option<StatusEffect>,
    activated: bool,
    chart: &TypeChart,
) -> (Option<StatusEffect>, Vec<TacticalEvent>) {
    let mut st = versus(skill, target, target_hp);
    {
        let u = st.unit_mut(2).expect("unit 2");
        u.status = prior;
        u.first_stand = !activated;
    }
    let out = strike(&mut st, chart);
    (unit_of(&st, 2).status, out.events)
}

/// BT2.5: a status lands iff hit ∧ not immune ∧ not KO'd ∧ no prior status ∧ the skill applies
/// one — the positive case and each of the five negatives.
/// Kills: a status on a miss, an immune hit or a KO; a prior status overwritten (stacking); a
/// status invented for a skill without one.
#[test]
fn a_status_lands_only_on_a_clean_surviving_hit_bt2_5() {
    let burn = SkillTactics {
        applies_status: Some(StatusKind::Burn),
        ..light(10, Affinity::Fire, melee())
    };
    let ch = chart();
    let chip = || water(100, CHIP_DEF, 40, vec![]);
    let (status, events) = status_after(burn.clone(), chip(), 100, None, true, &ch);
    assert_eq!(status, Some(StatusEffect::Burn));
    assert!(events.contains(&TacticalEvent::StatusApplied {
        unit: 2,
        status: StatusEffect::Burn,
    }));
    let never = SkillTactics {
        accuracy: 0,
        ..burn.clone()
    };
    assert_eq!(
        status_after(never, chip(), 100, None, true, &ch).0,
        None,
        "a miss"
    );
    assert_eq!(
        status_after(burn.clone(), chip(), 100, None, true, &immune_chart()).0,
        None,
        "an immune hit"
    );
    let (status, events) = status_after(
        burn.clone(),
        water(100, LETHAL_DEF, 40, vec![]),
        3,
        None,
        true,
        &ch,
    );
    assert_eq!(status, None, "a KO");
    assert!(events.contains(&TacticalEvent::Ko { unit: 2 }));
    let (status, events) = status_after(burn, chip(), 100, Some(StatusEffect::Poison), true, &ch);
    assert_eq!(status, Some(StatusEffect::Poison), "no stacking");
    assert!(!events
        .iter()
        .any(|e| matches!(e, TacticalEvent::StatusApplied { .. })));
    assert_eq!(
        status_after(
            light(10, Affinity::Fire, melee()),
            chip(),
            100,
            None,
            true,
            &ch
        )
        .0,
        None,
        "a skill without a status"
    );
}

/// The status the carried 1v1 `resolve_turn` applies to its defender, or `None` when it applies
/// none: a Water attack-10 attacker uses a Fire power-20 skill applying `kind` (the same numbers
/// as the tactics fixtures) under `chart` against a Water defender of 100 max HP at
/// `defender_hp`, with `defender_defense` and the `prior` status.
fn carried_status(
    kind: StatusKind,
    chart: &TypeChart,
    defender_hp: u16,
    defender_defense: u16,
    prior: Option<StatusEffect>,
) -> Option<StatusEffect> {
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Water,
        level: 5,
        current_hp: 100,
        max_hp: 100,
        stats: stat_block(100, 10, CHIP_DEF, 50),
        known_skill_ids: vec![1],
        status: None,
    };
    let defender = BattleMonster {
        species_id: 2,
        current_hp: defender_hp,
        stats: stat_block(100, 10, defender_defense, 40),
        status: prior,
        ..attacker.clone()
    };
    let mut battle = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![attacker],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![defender],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };
    let skill = SkillDef {
        id: 1,
        name: String::new(),
        affinity: Affinity::Fire,
        power: 20,
        accuracy: 100,
        pp: 10,
        sets_weather: None,
        applies_status: Some(kind),
    };
    let variance = TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    };
    resolve_turn(
        &mut battle,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass,
        &[skill],
        chart,
        &variance,
    )
    .into_iter()
    .find_map(|e| match e {
        BattleEvent::StatusApplied {
            side: SideId::SideB,
            status,
            ..
        } => Some(status),
        _ => None,
    })
}

/// The status the carried resolver applies on a clean chip hit (live chart, 100 HP, no prior).
fn carried_status_for(kind: StatusKind) -> StatusEffect {
    carried_status(kind, &chart(), 100, CHIP_DEF, None)
        .expect("the carried resolver applies the status on a clean hit")
}

/// BT2.5 (desync guard): the tactics status gate and the carried 1v1 resolver AGREE on whether
/// a status lands, driven with the same numbers — both apply Burn on a clean surviving hit, and
/// NEITHER applies one on an immune hit (hand-built immune chart), on a KO (3 HP, lethal
/// defence), or onto a defender that already has a status.
/// Kills: a tactics gate that drifts from M14 on any of the three negatives (e.g. a status
/// applied on an immune hit, onto a fainting target, or stacked over Poison).
#[test]
fn the_status_gate_agrees_with_the_carried_resolver_bt2_5() {
    let burn = SkillTactics {
        applies_status: Some(StatusKind::Burn),
        ..light(10, Affinity::Fire, melee())
    };
    let live = chart();
    let immune = immune_chart();
    let cases = [
        (
            "a clean hit",
            &live,
            100u16,
            CHIP_DEF,
            None,
            Some(StatusEffect::Burn),
        ),
        ("an immune hit", &immune, 100, CHIP_DEF, None, None),
        ("a KO", &live, 3, LETHAL_DEF, None, None),
        (
            "an already-poisoned defender",
            &live,
            100,
            CHIP_DEF,
            Some(StatusEffect::Poison),
            None,
        ),
    ];
    for (name, ch, hp, defense, prior, want) in cases {
        let carried = carried_status(StatusKind::Burn, ch, hp, defense, prior);
        let (_, events) = status_after(
            burn.clone(),
            water(100, defense, 40, vec![]),
            hp,
            prior,
            true,
            ch,
        );
        let tactics = events.iter().find_map(|e| match e {
            TacticalEvent::StatusApplied { unit: 2, status } => Some(*status),
            _ => None,
        });
        assert_eq!(carried, want, "carried, {name}");
        assert_eq!(tactics, carried, "tactics vs carried, {name}");
    }
}

/// BT2.5 (plan A10): the status a tactics hit applies is the carried M14 one for every
/// `StatusKind` — pinned by executing the carried public `resolve_turn` — and Sleep arrives
/// with 3 turns remaining.
/// Kills: a re-stated mapping that drifts from the carried one; Sleep with 1 or 2 turns.
#[test]
fn an_applied_status_is_the_carried_m14_status_bt2_5() {
    let kinds = [
        StatusKind::Poison,
        StatusKind::Burn,
        StatusKind::Paralysis,
        StatusKind::Sleep,
        StatusKind::Freeze,
    ];
    for kind in kinds {
        let carried = carried_status_for(kind);
        let skill = SkillTactics {
            applies_status: Some(kind),
            ..light(10, Affinity::Fire, melee())
        };
        let mut st = versus(skill, water(100, CHIP_DEF, 40, vec![]), 100);
        let out = strike(&mut st, &chart());
        assert_eq!(unit_of(&st, 2).status, Some(carried), "{kind:?}");
        assert!(
            out.events.contains(&TacticalEvent::StatusApplied {
                unit: 2,
                status: carried,
            }),
            "{kind:?}: {:?}",
            out.events
        );
    }
    assert_eq!(
        carried_status_for(StatusKind::Sleep),
        StatusEffect::Sleep { turns_remaining: 3 }
    );
}

// ===========================================================================
// BT2.1 — the TurnStart refresh
// ===========================================================================

/// BT2.1: TurnStart refreshes the budget to exactly `fresh` — leftover AP, strides, attacks
/// and the last action do not carry over, AP above the allowance is not banked — and reads
/// `ap_turn` from the tuning it is handed; the other units are untouched.
/// Kills: `ap += ap_turn` (banking); strides/attacks/last left over; a hard-coded 6.
#[test]
fn turn_start_refreshes_the_budget_with_no_carry_over_bt2_1() {
    let mut st = duel(BattleKind::Pvp, 3);
    let fresh = TurnBudget {
        ap: 6,
        strides_used: 0,
        attacks: 0,
        last: None,
    };
    st.unit_mut(1).expect("unit 1").budget = TurnBudget {
        ap: 1,
        strides_used: 2,
        attacks: 2,
        last: Some(Entry::Attack(Tier::Heavy)),
    };
    ready(&mut st, 1);
    assert_eq!(unit_of(&st, 1).budget, fresh);
    st.unit_mut(1).expect("unit 1").budget.ap = 9;
    ready(&mut st, 1);
    assert_eq!(
        unit_of(&st, 1).budget,
        fresh,
        "no banking above the allowance"
    );
    turn_start(&mut st, 1, &perturb(|t| t.ap_turn = 9)).expect("unit 1 starts");
    assert_eq!(unit_of(&st, 1).budget.ap, 9);
    assert_eq!(
        unit_of(&st, 2).budget,
        TurnBudget::default(),
        "unit 2 is still idle"
    );
}

// ===========================================================================
// BT2.3 — Guard (resolve)
// ===========================================================================

/// Unit 1 spends `entry` straight from its budget (a Move/Item the executor resolved).
fn spend_on(st: &mut TacticalState, entry: Entry, t: &TacticsTuning) {
    let budget = &mut st.unit_mut(1).expect("unit 1").budget;
    spend(budget, entry, t).expect("an affordable entry");
}

/// BT2.3 (plan A6): TurnEnd sets Guard by the rule — pure End, the 2-stride chaser (pre-queued
/// drain) and Item + End (AI end) are Guarded; an auto-pass, a taxed 2-stride retreat (1 AP
/// left), any attack, and a last action of Recruit or Flee (even with 2 AP left at
/// `ap_turn` 8) are not — and every TurnEnd leaves the budget idle (`TurnBudget::default()`).
/// Kills: Guard on auto-pass; Guard after attacking; Recruit/Flee not excluded; the budget kept
/// after TurnEnd (letting the unit act out of turn).
#[test]
fn turn_end_grants_guard_by_the_rule_and_leaves_the_budget_idle_bt2_3() {
    let tu = design();
    let end = |prepare: fn(&mut TacticalState), cause: TurnEndCause| -> (bool, bool, TurnBudget) {
        let mut st = duel(BattleKind::Pvp, 3);
        ready(&mut st, 1);
        prepare(&mut st);
        let granted = turn_end(&mut st, 1, cause, &tu).expect("unit 1 can end its turn");
        let u = unit_of(&st, 1);
        (granted, u.guard, u.budget)
    };
    let idle = TurnBudget::default();
    assert_eq!(end(|_| {}, TurnEndCause::EndTurn), (true, true, idle));
    assert_eq!(end(|_| {}, TurnEndCause::AutoPass), (false, false, idle));
    assert_eq!(
        end(
            |st| spend_on(
                st,
                Entry::Move {
                    strides: 2,
                    taxed: false
                },
                &design()
            ),
            TurnEndCause::PreQueuedDrain
        ),
        (true, true, idle)
    );
    assert_eq!(
        end(
            |st| spend_on(st, Entry::Item, &design()),
            TurnEndCause::AiEnd
        ),
        (true, true, idle)
    );
    assert_eq!(
        end(
            |st| spend_on(
                st,
                Entry::Move {
                    strides: 2,
                    taxed: true
                },
                &design()
            ),
            TurnEndCause::EndTurn
        ),
        (false, false, idle)
    );
    assert_eq!(
        end(
            |st| {
                resolve_attack(st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid attack");
            },
            TurnEndCause::EndTurn
        ),
        (false, false, idle)
    );

    let roomy = perturb(|t| t.ap_turn = 8);
    for (last, want) in [
        (Entry::Recruit, false),
        (Entry::Flee, false),
        (Entry::Item, true),
    ] {
        let mut st = duel(BattleKind::Pvp, 3);
        turn_start(&mut st, 1, &roomy).expect("unit 1 starts");
        spend_on(&mut st, last, &roomy);
        assert_eq!(
            turn_end(&mut st, 1, TurnEndCause::EndTurn, &roomy),
            Ok(want),
            "{last:?}"
        );
        assert_eq!(unit_of(&st, 1).guard, want, "{last:?}");
    }
}

/// BT2.3 (plan A6): after TurnEnd the idle budget refuses an attack (Economy, Unaffordable at
/// cost 2 with 0 AP) and the state is untouched.
/// Kills: a TurnEnd that keeps the AP (an attack after End, i.e. Guard plus damage).
#[test]
fn an_attack_after_turn_end_is_unaffordable_and_changes_nothing_bt2_3() {
    let mut st = duel(BattleKind::Pvp, 3);
    ready(&mut st, 1);
    assert_eq!(
        turn_end(&mut st, 1, TurnEndCause::EndTurn, &design()),
        Ok(true)
    );
    assert_rejected(
        st,
        1,
        10,
        c(3, 3),
        ResolveError::Economy(EconomyError::Unaffordable { cost: 2, ap: 0 }),
    );
}

/// BT2.3: Guard multiplies incoming attack damage by 3/4 exactly ONCE and is the TARGET's flag
/// (14 → 10, not 7; an attacker's own Guard leaves its outgoing 14 alone); the ratio is read
/// from the tuning (1/2 → 7). Through `resolve_attack` the Guarded target's result carries
/// `guard: true` with the cut damage, and taking a hit does not spend Guard.
/// Kills: Guard applied twice; Guard read from the attacker; a hard-coded 3/4; Guard consumed
/// by the first hit.
#[test]
fn guard_cuts_incoming_attack_damage_once_by_the_targets_flag_bt2_3() {
    let ch = chart();
    let tu = design();
    let attacker = fire_attacker();
    let mut target = plant_target(100);
    let open = damage_pipeline(&attacker, &target, &fire40(), &ch, false, SURE, &tu);
    assert_eq!((open.d1, open.d2, open.d3), (14, 14, 14));
    target.guard = true;
    let guarded = damage_pipeline(&attacker, &target, &fire40(), &ch, false, SURE, &tu);
    assert_eq!(
        (
            guarded.d1,
            guarded.d2,
            guarded.d3,
            guarded.applied,
            guarded.hp_after
        ),
        (14, 10, 10, 10, 90)
    );
    let half = perturb(|t| {
        t.guard_num = 1;
        t.guard_den = 2;
    });
    assert_eq!(
        damage_pipeline(&attacker, &target, &fire40(), &ch, false, SURE, &half).d2,
        7
    );
    let mut guarded_attacker = fire_attacker();
    guarded_attacker.guard = true;
    target.guard = false;
    assert_eq!(
        damage_pipeline(&guarded_attacker, &target, &fire40(), &ch, false, SURE, &tu).d2,
        14
    );

    let mut st = versus(
        light(10, Affinity::Fire, melee()),
        water(50, LETHAL_DEF, 40, vec![]),
        50,
    );
    st.unit_mut(2).expect("unit 2").guard = true;
    let variance = rolls_at(st.seed, st.action_seq).variance;
    let out = strike(&mut st, &ch);
    let unguarded = 9 * u16::from(variance) / 100;
    let r = &executed_results(&out)[0];
    assert_eq!((r.guard, r.damage), (true, (unguarded * 3 / 4).max(1)));
    assert!(unit_of(&st, 2).guard, "taking a hit does not spend Guard");
}

/// BT2.3: TurnStart clears the activating unit's Guard (and only its).
/// Kills: Guard that lasts past the unit's next TurnStart; TurnStart clearing every Guard.
#[test]
fn turn_start_clears_guard_bt2_3() {
    let mut st = duel(BattleKind::Pvp, 3);
    st.unit_mut(1).expect("unit 1").guard = true;
    st.unit_mut(2).expect("unit 2").guard = true;
    ready(&mut st, 1);
    assert!(!unit_of(&st, 1).guard);
    assert!(unit_of(&st, 2).guard, "only the activating unit loses it");
}

// ===========================================================================
// BT2.6 — First-Stand
// ===========================================================================

/// BT2.6: First-Stand saves at d3 == hp AND d3 > hp — hp_after 1, stood_ground, applied hp − 1
/// — for d0 14 against 14, 13 and 1 HP.
/// Kills: `>` for `>=`; a save that leaves 0; applied reported as d3.
#[test]
fn first_stand_saves_a_lethal_hit_at_or_above_current_hp_bt2_6() {
    let ch = chart();
    let tu = design();
    for (cur_hp, applied) in [(14u16, 13u16), (13, 12), (1, 0)] {
        let trace = damage_pipeline(
            &fire_attacker(),
            &plant_target(cur_hp),
            &fire40(),
            &ch,
            false,
            SURE,
            &tu,
        );
        assert_eq!(
            (trace.d3, trace.hp_after, trace.applied, trace.stood_ground),
            (14, 1, applied, true),
            "cur_hp {cur_hp}"
        );
    }
}

/// BT2.6: one below lethal (d3 14 into 15 HP) is an ordinary hit — hp 1, applied 14, no save —
/// and a unit without the flag is taken from 14 to 0 (no unconditional clamp).
/// Kills: First-Stand firing on `d3 >= hp - 1`; a clamp to 1 for every unit.
#[test]
fn first_stand_does_not_fire_below_lethal_or_without_the_flag_bt2_6() {
    let ch = chart();
    let tu = design();
    let near = damage_pipeline(
        &fire_attacker(),
        &plant_target(15),
        &fire40(),
        &ch,
        false,
        SURE,
        &tu,
    );
    assert_eq!(
        (near.hp_after, near.applied, near.stood_ground),
        (1, 14, false)
    );
    let mut veteran = plant_target(14);
    veteran.first_stand = false;
    let kod = damage_pipeline(&fire_attacker(), &veteran, &fire40(), &ch, false, SURE, &tu);
    assert_eq!(
        (kod.hp_after, kod.applied, kod.stood_ground),
        (0, 14, false)
    );
}

/// BT2.6: a saving First-Stand emits `StoodGround`, leaves the unit at 1 HP and Active, reports
/// damage hp − 1 with `ko: false`, and clears the flag.
/// Kills: no StoodGround event; the flag kept after saving; the save reported as a KO.
#[test]
fn a_saving_first_stand_emits_stood_ground_and_clears_bt2_6() {
    let mut st = versus(
        light(10, Affinity::Fire, melee()),
        water(6, LETHAL_DEF, 40, vec![]),
        6,
    );
    let out = strike(&mut st, &chart());
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![TargetResult {
                    unit: 2,
                    hit: true,
                    damage: 5,
                    effectiveness: NVE,
                    flank: false,
                    guard: false,
                    ko: false,
                }],
            },
            TacticalEvent::StoodGround { unit: 2 },
        ]
    );
    let saved = unit_of(&st, 2);
    assert_eq!(
        (saved.cur_hp, saved.first_stand, saved.state),
        (1, false, UnitState::Active)
    );
}

/// BT2.6 (plan A2, the EARS literal): the flag clears on the save, so the NEXT lethal hit KOs
/// (here the same attacker's Exerted second Light).
/// Kills: a First-Stand that persists after saving (an unkillable unit until it activates).
#[test]
fn the_next_lethal_hit_after_a_save_kos_bt2_6() {
    let mut st = versus(
        light(10, Affinity::Fire, melee()),
        water(6, LETHAL_DEF, 40, vec![]),
        6,
    );
    strike(&mut st, &chart());
    assert_eq!(unit_of(&st, 2).cur_hp, 1);
    let out = strike(&mut st, &chart());
    assert_eq!(out.ap_spent, 4);
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![TargetResult {
                    unit: 2,
                    hit: true,
                    damage: 1,
                    effectiveness: NVE,
                    flank: false,
                    guard: false,
                    ko: true,
                }],
            },
            TacticalEvent::Ko { unit: 2 },
        ]
    );
    let fallen = unit_of(&st, 2);
    assert_eq!((fallen.cur_hp, fallen.state), (0, UnitState::Fainted));
}

/// BT2.6: a unit that has activated (its TurnStart cleared First-Stand) is KO'd by a lethal hit
/// from full HP.
/// Kills: First-Stand kept past the first TurnStart; an unconditional 1-HP clamp.
#[test]
fn a_unit_that_has_activated_is_kod_by_a_lethal_hit_from_full_hp_bt2_6() {
    let mut st = versus(
        light(10, Affinity::Fire, melee()),
        water(5, LETHAL_DEF, 40, vec![]),
        5,
    );
    ready(&mut st, 2);
    assert!(!unit_of(&st, 2).first_stand);
    let out = strike(&mut st, &chart());
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![TargetResult {
                    unit: 2,
                    hit: true,
                    damage: 5,
                    effectiveness: NVE,
                    flank: false,
                    guard: false,
                    ko: true,
                }],
            },
            TacticalEvent::Ko { unit: 2 },
        ]
    );
}

/// BT2.6: a miss, an immune hit and a non-lethal hit all leave First-Stand set.
/// Kills: First-Stand cleared by being targeted or by any hit.
#[test]
fn a_miss_an_immune_hit_and_a_non_lethal_hit_keep_first_stand_bt2_6() {
    let never = SkillTactics {
        accuracy: 0,
        ..light(10, Affinity::Fire, melee())
    };
    let mut missed = versus(never, water(5, LETHAL_DEF, 40, vec![]), 5);
    strike(&mut missed, &chart());
    assert_eq!(
        (unit_of(&missed, 2).cur_hp, unit_of(&missed, 2).first_stand),
        (5, true)
    );
    let mut immune = versus(
        light(10, Affinity::Fire, melee()),
        water(5, LETHAL_DEF, 40, vec![]),
        5,
    );
    strike(&mut immune, &immune_chart());
    assert_eq!(
        (unit_of(&immune, 2).cur_hp, unit_of(&immune, 2).first_stand),
        (5, true)
    );
    let mut grazed = versus(
        light(10, Affinity::Fire, melee()),
        water(100, CHIP_DEF, 40, vec![]),
        100,
    );
    strike(&mut grazed, &chart());
    assert_eq!(
        (unit_of(&grazed, 2).cur_hp, unit_of(&grazed, 2).first_stand),
        (99, true)
    );
}

/// BT2.6: the first TurnStart clears First-Stand with no damage and no other change to HP or
/// status.
/// Kills: First-Stand that survives activation; TurnStart touching HP.
#[test]
fn turn_start_clears_first_stand_without_damage_bt2_6() {
    let mut st = duel(BattleKind::Pvp, 3);
    st.unit_mut(2).expect("unit 2").status = Some(StatusEffect::Poison);
    assert!(unit_of(&st, 2).first_stand);
    ready(&mut st, 2);
    let u = unit_of(&st, 2);
    assert_eq!(
        (u.first_stand, u.cur_hp, u.status),
        (false, 100, Some(StatusEffect::Poison))
    );
}

/// BT2.6: deployment sets First-Stand, Active, no Guard, no status, an idle budget, and the
/// given HP.
/// Kills: a deployed unit without First-Stand (round-1 deletion reopens).
#[test]
fn deploy_sets_first_stand_and_an_idle_unit_bt2_6() {
    let u = unit(7, Side::B, 2, c(4, 4), water(80, CHIP_DEF, 40, vec![]), 60);
    assert!(u.first_stand);
    assert_eq!(
        (u.id, u.side, u.slot, u.pos, u.cur_hp, u.state, u.guard, u.status, u.budget),
        (
            7,
            Side::B,
            2,
            c(4, 4),
            60,
            UnitState::Active,
            false,
            None,
            TurnBudget::default()
        )
    );
    assert_eq!(u.max_hp(), 80);
    assert!(u.is_conscious());
}

/// BT2.6 (plan A2, the exhaustive max-burst simulation): for every ordered pair of the live
/// 20-species roster at every level 5..=100 (zero IVs/EVs, neutral nature), with STAB, a
/// hand-built ×2 chart for that pair, flank, variance 100 and a sure hit, the single-unit nova
/// (one Heavy 75, or a Light 20 then another Light 20 on the result) never KOs a full-HP
/// First-Stand target: 20 × 20 × 96 = 38 400 cases.
/// Kills: a First-Stand that does not save; a Light that clears the flag without saving.
#[test]
fn a_single_unit_nova_never_kos_a_first_stand_unit_on_the_roster_bt2_6() {
    let roster = load_species().expect("the embedded species parse");
    assert_eq!(roster.len(), 20, "the live roster");
    let ivs = IVs::new(0, 0, 0, 0, 0, 0).expect("zero IVs are valid");
    let evs = EVs::zero();
    let nature = Nature::new(NatureKind::Hardy);
    let tu = design();
    let mut checked = 0u32;
    for att in &roster {
        for tgt in &roster {
            let chart = TypeChart::new(&[TypeRelation {
                attacker: att.affinity,
                defender: tgt.affinity,
                effectiveness: 20,
            }]);
            let heavy75 = heavy(1, att.affinity, 75, melee());
            let light20 = light(2, att.affinity, melee());
            for level in 5u8..=100 {
                let lv = Level::new(level).expect("5..=100 is a level");
                let a_stats = derive_stats(&att.base_stats, &ivs, &evs, &nature, lv);
                let t_stats = derive_stats(&tgt.base_stats, &ivs, &evs, &nature, lv);
                let attacker = unit(
                    1,
                    Side::A,
                    0,
                    c(0, 0),
                    kit(
                        att.id,
                        att.affinity,
                        level,
                        a_stats,
                        att.base_stats.speed,
                        MoveClass::Walk,
                        vec![],
                    ),
                    a_stats.hp,
                );
                let target = unit(
                    2,
                    Side::B,
                    0,
                    c(1, 0),
                    kit(
                        tgt.id,
                        tgt.affinity,
                        level,
                        t_stats,
                        tgt.base_stats.speed,
                        MoveClass::Walk,
                        vec![],
                    ),
                    t_stats.hp,
                );
                let nova = damage_pipeline(&attacker, &target, &heavy75, &chart, true, SURE, &tu);
                assert!(
                    nova.hit && nova.hp_after >= 1,
                    "Heavy 75: {} -> {} at L{level}: {nova:?}",
                    att.name,
                    tgt.name
                );
                let first = damage_pipeline(&attacker, &target, &light20, &chart, true, SURE, &tu);
                let mut hurt = target.clone();
                hurt.cur_hp = first.hp_after;
                hurt.first_stand = !first.stood_ground;
                let second = damage_pipeline(&attacker, &hurt, &light20, &chart, true, SURE, &tu);
                assert!(
                    first.hp_after >= 1 && second.hp_after >= 1,
                    "Light + Light: {} -> {} at L{level}: {first:?} then {second:?}",
                    att.name,
                    tgt.name
                );
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 20 * 20 * 96);
}

// ===========================================================================
// BT2.10 — the r2 0-HP family
// ===========================================================================

/// BT2.10: only conscious units deploy — cur_hp 0 is `Fainted { id }` (never clamped to 1),
/// from `deploy_unit`, from `validate_unit` and from `TacticalState::new`; 1 HP deploys.
/// Kills: a clamp to 1; a 0-HP unit let into a battle through `new`.
#[test]
fn deploy_refuses_a_zero_hp_unit_and_never_clamps_it_bt2_10() {
    assert_eq!(
        deploy_unit(7, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 50, vec![]), 0),
        Err(DeployError::Fainted { id: 7 })
    );
    assert_eq!(
        deploy_unit(7, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 50, vec![]), 1).map(|u| u.cur_hp),
        Ok(1)
    );
    let mut corpse = unit(7, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 50, vec![]), 50);
    corpse.cur_hp = 0;
    assert_eq!(validate_unit(&corpse), Err(DeployError::Fainted { id: 7 }));
    let foe = unit(8, Side::B, 0, c(6, 6), water(50, CHIP_DEF, 40, vec![]), 50);
    assert_eq!(
        TacticalState::new(BattleKind::Wild, 1, &open_map(), vec![corpse, foe]).err(),
        Some(DeployError::Fainted { id: 7 })
    );
}

/// BT2.10 (plan A4): the per-unit checks run Fainted → HpAboveMax → ZeroDefense, each with its
/// exact payload, and each boundary's other side deploys (cur_hp == max_hp, defence 1).
/// Kills: HP above max clamped down; defence 0 let through to `calc_damage`; the order swapped.
#[test]
fn deploy_checks_hp_then_the_maximum_then_defence_bt2_10() {
    let make = |cur_hp: u16, defense: u16| {
        deploy_unit(
            7,
            Side::A,
            0,
            c(0, 0),
            water(100, defense, 50, vec![]),
            cur_hp,
        )
    };
    assert_eq!(
        make(101, CHIP_DEF).err(),
        Some(DeployError::HpAboveMax {
            id: 7,
            cur_hp: 101,
            max_hp: 100
        })
    );
    assert_eq!(make(100, CHIP_DEF).map(|u| u.cur_hp), Ok(100));
    assert_eq!(make(100, 0).err(), Some(DeployError::ZeroDefense { id: 7 }));
    assert_eq!(make(100, 1).map(|u| u.kit.stats.defense), Ok(1));
    assert_eq!(make(0, 0).err(), Some(DeployError::Fainted { id: 7 }));
    assert_eq!(
        make(101, 0).err(),
        Some(DeployError::HpAboveMax {
            id: 7,
            cur_hp: 101,
            max_hp: 100
        })
    );
}

/// BT2.10 (plan A4): `TacticalState::new` validates every unit first, then the set — duplicate
/// id, duplicate (side, slot), a bad position (off the map, or a tile already held), an empty
/// side — in that order: one unit clashing on everything is fixed one fault at a time.
/// Kills: any set check missing; the order swapped; a shared tile allowed.
#[test]
fn a_new_battle_rejects_a_bad_roster_in_the_stated_order_bt2_10() {
    let a = unit(1, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 50, vec![]), 50);
    let b = unit(2, Side::B, 0, c(6, 6), water(50, CHIP_DEF, 40, vec![]), 50);
    let build =
        |units: Vec<TacticalUnit>| TacticalState::new(BattleKind::Pvp, 1, &open_map(), units).err();
    let mut x = unit(1, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 30, vec![]), 50);
    x.cur_hp = 0;
    assert_eq!(
        build(vec![a.clone(), b.clone(), x.clone()]),
        Some(DeployError::Fainted { id: 1 })
    );
    x.cur_hp = 50;
    assert_eq!(
        build(vec![a.clone(), b.clone(), x.clone()]),
        Some(DeployError::DuplicateId { id: 1 })
    );
    x.id = 3;
    assert_eq!(
        build(vec![a.clone(), b.clone(), x.clone()]),
        Some(DeployError::DuplicateSlot {
            side: Side::A,
            slot: 0
        })
    );
    x.slot = 1;
    assert_eq!(
        build(vec![a.clone(), b.clone(), x.clone()]),
        Some(DeployError::BadPosition { id: 3 }),
        "the tile is already held"
    );
    for off_map in [c(7, 0), c(0, 7)] {
        x.pos = off_map;
        assert_eq!(
            build(vec![a.clone(), b.clone(), x.clone()]),
            Some(DeployError::BadPosition { id: 3 }),
            "{off_map:?}"
        );
    }
    x.pos = c(1, 1);
    assert_eq!(build(vec![a.clone(), b.clone(), x.clone()]), None);
    assert_eq!(
        build(vec![a.clone(), x.clone()]),
        Some(DeployError::EmptySide { side: Side::B })
    );
    assert_eq!(
        build(vec![b]),
        Some(DeployError::EmptySide { side: Side::A })
    );
    x.pos = c(0, 0);
    assert_eq!(
        build(vec![a, x]),
        Some(DeployError::BadPosition { id: 3 }),
        "a bad position is reported before an empty side"
    );
}

/// BT2.10 (plan A4): `new` canonicalises `units` to (side, slot) order whatever the input order.
/// Kills: units kept in input order (every per-unit iteration then depends on the caller).
#[test]
fn a_new_battle_orders_its_units_by_side_then_slot_bt2_10() {
    let st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(10, Side::B, 1, c(6, 2), water(50, CHIP_DEF, 10, vec![]), 50),
            unit(11, Side::A, 2, c(0, 4), water(50, CHIP_DEF, 20, vec![]), 50),
            unit(12, Side::B, 0, c(6, 0), water(50, CHIP_DEF, 30, vec![]), 50),
            unit(13, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 40, vec![]), 50),
            unit(14, Side::A, 1, c(0, 2), water(50, CHIP_DEF, 50, vec![]), 50),
        ],
    );
    let ids: Vec<u32> = st.units.iter().map(|u| u.id).collect();
    assert_eq!(ids, vec![13, 14, 11, 12, 10]);
}

/// BT2.10: `can_act` checks BattleOver, then UnknownUnit, then Recruited, then Fainted — and a
/// unit still `Active` but hand-set to 0 HP is Fainted (as is a Fainted unit with HP left).
/// Kills: a 0-HP Active unit allowed to act; the precedence swapped.
#[test]
fn can_act_checks_over_then_unknown_then_recruited_then_fainted_bt2_10() {
    let mut st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(1, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 50, vec![]), 50),
            unit(2, Side::A, 1, c(0, 2), water(50, CHIP_DEF, 40, vec![]), 50),
            unit(3, Side::B, 0, c(6, 0), water(50, CHIP_DEF, 30, vec![]), 50),
            unit(4, Side::B, 1, c(6, 2), water(50, CHIP_DEF, 20, vec![]), 50),
            unit(5, Side::B, 2, c(6, 4), water(50, CHIP_DEF, 10, vec![]), 50),
        ],
    );
    assert_eq!(can_act(&st, 1), Ok(()));
    assert!(unit_of(&st, 1).is_conscious());
    assert_eq!(can_act(&st, 99), Err(ActError::UnknownUnit(99)));
    {
        let u = st.unit_mut(2).expect("unit 2");
        u.state = UnitState::Recruited;
        u.cur_hp = 0;
    }
    assert_eq!(can_act(&st, 2), Err(ActError::Recruited(2)));
    {
        let u = st.unit_mut(3).expect("unit 3");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
    }
    assert_eq!(can_act(&st, 3), Err(ActError::Fainted(3)));
    st.unit_mut(4).expect("unit 4").cur_hp = 0;
    assert_eq!(can_act(&st, 4), Err(ActError::Fainted(4)));
    assert!(!unit_of(&st, 4).is_conscious());
    st.unit_mut(5).expect("unit 5").state = UnitState::Fainted;
    assert_eq!(can_act(&st, 5), Err(ActError::Fainted(5)));
    assert!(!unit_of(&st, 5).is_conscious());
    st.outcome = BattleOutcome::SideAWins;
    for id in [99, 1, 2, 3] {
        assert_eq!(can_act(&st, id), Err(ActError::BattleOver), "unit {id}");
    }
}

/// BT2.10: a 0-HP unit (Active hand-set to 0, or Fainted) cannot TurnStart, TurnEnd or attack;
/// each refusal leaves the state `==` before (its Guard is not cleared, no AP spent).
/// Kills: TurnStart run on a corpse (clearing Guard, refreshing AP); a corpse attacking.
#[test]
fn a_zero_hp_or_fainted_unit_cannot_start_end_or_attack_bt2_10() {
    let tu = design();
    for faint_state in [UnitState::Active, UnitState::Fainted] {
        let mut st = duel(BattleKind::Pvp, 2);
        ready(&mut st, 1);
        {
            let u = st.unit_mut(1).expect("unit 1");
            u.cur_hp = 0;
            u.state = faint_state;
            u.guard = true;
        }
        let before = st.clone();
        assert_eq!(turn_start(&mut st, 1, &tu), Err(ActError::Fainted(1)));
        assert_eq!(st, before);
        assert_eq!(
            turn_end(&mut st, 1, TurnEndCause::EndTurn, &tu),
            Err(ActError::Fainted(1))
        );
        assert_eq!(st, before);
        assert_eq!(
            resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &tu),
            Err(ResolveError::Act(ActError::Fainted(1)))
        );
        assert_eq!(st, before);
    }
}

/// A's fast 1 Lights B's slow 2 (lethal, activated) while B's 3 waits; the order is [1, 3, 2].
fn mid_round(queued: Vec<u32>) -> (AttackOutcome, TacticalState) {
    let mut st = state(
        BattleKind::Pvp,
        6,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(100, CHIP_DEF, 90, vec![light(10, Affinity::Fire, melee())]),
                100,
            ),
            unit(2, Side::B, 0, c(3, 3), water(5, LETHAL_DEF, 10, vec![]), 5),
            unit(
                3,
                Side::B,
                1,
                c(6, 6),
                water(100, CHIP_DEF, 50, vec![]),
                100,
            ),
        ],
    );
    assert_eq!(st.initiative, vec![1, 3, 2]);
    st.unit_mut(2).expect("unit 2").first_stand = false;
    st.queued = queued;
    ready(&mut st, 1);
    let out = strike(&mut st, &chart());
    (out, st)
}

/// BT2.10: a unit KO'd mid-round, later in the initiative and holding a READY plan, leaves the
/// initiative and `queued` at once with `Ko` then `QueueVoided`; the others keep their places.
/// Kills: a KO'd unit left in the order (it would take a turn); the plan silently kept or
/// silently dropped (no event).
#[test]
fn a_unit_kod_mid_round_leaves_the_order_and_its_plan_is_voided_bt2_10() {
    let (out, st) = mid_round(vec![2, 3]);
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![TargetResult {
                    unit: 2,
                    hit: true,
                    damage: 5,
                    effectiveness: NVE,
                    flank: false,
                    guard: false,
                    ko: true,
                }],
            },
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::QueueVoided { unit: 2 },
        ]
    );
    assert_eq!(st.initiative, vec![1, 3]);
    assert_eq!(st.queued, vec![3]);
    assert_eq!(unit_of(&st, 2).state, UnitState::Fainted);
}

/// BT2.10: a KO'd unit with no READY plan emits `Ko` only.
/// Kills: a `QueueVoided` for a plan that never existed.
#[test]
fn an_unqueued_ko_emits_ko_only_bt2_10() {
    let (out, st) = mid_round(vec![3]);
    assert_eq!(out.events[1..], [TacticalEvent::Ko { unit: 2 }]);
    assert_eq!(st.initiative, vec![1, 3]);
    assert_eq!(st.queued, vec![3]);
}

/// BT2.10: an `All`-filter splash that KOs its own actor (A's 1, 5 HP, activated, at (2,3)
/// inside the diamond around B's 2) still finishes every target (2 grazed, 4 at (4,3) KO'd
/// after it), then the actor is Fainted, out of the order, and `can_act` refuses it — the
/// executor's turn-end signal; the battle goes on (A's 5 waits).
/// Kills: the loop stopped at the actor's KO; the actor left Active or in the order.
#[test]
fn an_all_aoe_that_kos_its_actor_finishes_the_targets_then_ends_its_turn_bt2_10() {
    let splash = light(10, Affinity::Fire, diamond(FfFilter::All, 1));
    let mut st = state(
        BattleKind::Pvp,
        13,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(5, LETHAL_DEF, 50, vec![splash]),
                5,
            ),
            unit(
                5,
                Side::A,
                1,
                c(0, 6),
                water(100, CHIP_DEF, 20, vec![]),
                100,
            ),
            unit(
                2,
                Side::B,
                0,
                c(3, 3),
                water(100, CHIP_DEF, 40, vec![]),
                100,
            ),
            unit(4, Side::B, 1, c(4, 3), water(5, LETHAL_DEF, 30, vec![]), 5),
        ],
    );
    st.unit_mut(4).expect("unit 4").first_stand = false;
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid splash");
    let hit = |unit: u32, damage: u16, ko: bool| TargetResult {
        unit,
        hit: true,
        damage,
        effectiveness: NVE,
        flank: false,
        guard: false,
        ko,
    };
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![hit(1, 5, true), hit(2, 1, false), hit(4, 5, true)],
            },
            TacticalEvent::Ko { unit: 1 },
            TacticalEvent::Ko { unit: 4 },
        ]
    );
    assert_eq!(unit_of(&st, 1).state, UnitState::Fainted);
    assert!(!st.initiative.contains(&1));
    assert!(!st.initiative.contains(&4));
    assert_eq!(can_act(&st, 1), Err(ActError::Fainted(1)));
    assert_eq!(st.outcome, BattleOutcome::Ongoing);
    assert_eq!(
        st.attack_damage_dealt,
        [6, 0],
        "self-damage is not dealt damage"
    );
}

/// A's last unit 1 (5/50 HP, 10 %) splashes all within 1 of B's last unit 2 (5/10 HP, 50 %,
/// activated): both die in one attack.
fn last_stand(kind: BattleKind) -> (AttackOutcome, TacticalState) {
    let splash = light(10, Affinity::Fire, diamond(FfFilter::All, 1));
    let mut st = state(
        kind,
        17,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(50, LETHAL_DEF, 50, vec![splash]),
                5,
            ),
            unit(2, Side::B, 0, c(3, 3), water(10, LETHAL_DEF, 40, vec![]), 5),
        ],
    );
    st.unit_mut(2).expect("unit 2").first_stand = false;
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid splash");
    (out, st)
}

/// BT2.10: a PvE (wild) double-KO follows the standing r2 ruling — the player side A is found
/// empty first — so `SideBWins` by `FixedOrder`.
/// Kills: a Draw/Fled outcome; adjudication applied to a wild battle; A winning a mutual wipe.
#[test]
fn a_wild_double_ko_goes_to_side_b_by_the_fixed_order_ruling_bt2_10() {
    let (out, st) = last_stand(BattleKind::Wild);
    assert_eq!(
        out.events.last(),
        Some(&TacticalEvent::BattleEnd {
            outcome: BattleOutcome::SideBWins,
            how: BattleEndHow::FixedOrder,
        })
    );
    assert_eq!(st.outcome, BattleOutcome::SideBWins);
}

/// BT2.10: a PvP double-KO is adjudicated by BT2.9 from the step-START snapshot — B held 50 %
/// against A's 10 %, so B wins on HP percent (afterwards both are at 0 and only A has dealt
/// damage, so a post-attack snapshot would hand it to A).
/// Kills: the fixed-order ruling applied to PvP; the snapshot taken after the damage.
#[test]
fn a_pvp_double_ko_is_adjudicated_from_the_pre_attack_snapshot_bt2_10() {
    let (out, st) = last_stand(BattleKind::Pvp);
    let hit = |unit: u32| TargetResult {
        unit,
        hit: true,
        damage: 5,
        effectiveness: NVE,
        flank: false,
        guard: false,
        ko: true,
    };
    assert_eq!(
        out.events,
        vec![
            TacticalEvent::Executed {
                attacker: 1,
                skill_id: 10,
                results: vec![hit(1), hit(2)],
            },
            TacticalEvent::Ko { unit: 1 },
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::BattleEnd {
                outcome: BattleOutcome::SideBWins,
                how: BattleEndHow::Adjudicated(Adjudication::HpPercent),
            },
        ]
    );
    assert_eq!(st.outcome, BattleOutcome::SideBWins);
    assert_eq!(st.attack_damage_dealt, [5, 0]);
}

// ===========================================================================
// Round 2 — gaps found by review and red-team
// ===========================================================================

/// BT2.5 (judgement 5): both rolls are drawn for every target even when the skill cannot miss —
/// an accuracy-100 Light advances `action_seq` by exactly 2 for one target and by 6 for three,
/// and each target's damage still comes from the variance of its OWN pair (lethal defence:
/// damage = 9·v/100 with v the second draw of the pair).
/// Kills: skipping the accuracy draw when accuracy ≥ 100 (the stream would shift by one per
/// target, and later targets would read the wrong variance).
#[test]
fn a_sure_hit_still_draws_both_rolls_for_every_target_bt2_5() {
    let mut one = versus(
        light(10, Affinity::Fire, melee()),
        water(50, LETHAL_DEF, 40, vec![]),
        50,
    );
    let seq = one.action_seq;
    let variance = rolls_at(one.seed, seq).variance;
    let out = strike(&mut one, &chart());
    assert_eq!(one.action_seq, seq + 2, "one target, two draws");
    assert_eq!(
        executed_results(&out)[0].damage,
        9 * u16::from(variance) / 100
    );

    let seed = 77;
    let mut st = state(
        BattleKind::Pvp,
        seed,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 1),
                water(
                    100,
                    CHIP_DEF,
                    50,
                    vec![light(10, Affinity::Fire, diamond(FfFilter::Enemies, 2))],
                ),
                100,
            ),
            unit(
                3,
                Side::B,
                0,
                c(4, 3),
                water(50, LETHAL_DEF, 40, vec![]),
                50,
            ),
            unit(
                4,
                Side::B,
                1,
                c(3, 3),
                water(50, LETHAL_DEF, 30, vec![]),
                50,
            ),
            unit(
                5,
                Side::B,
                2,
                c(2, 3),
                water(50, LETHAL_DEF, 20, vec![]),
                50,
            ),
        ],
    );
    ready(&mut st, 1);
    let seq0 = st.action_seq;
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid AoE");
    assert_eq!(st.action_seq, seq0 + 6, "three targets, six draws");
    let got: Vec<(u32, u16)> = executed_results(&out)
        .iter()
        .map(|r| (r.unit, r.damage))
        .collect();
    let want: Vec<(u32, u16)> = [5u32, 4, 3]
        .into_iter()
        .enumerate()
        .map(|(i, id)| {
            let v = rolls_at(seed, seq0 + 2 * i as u64).variance;
            (id, 9 * u16::from(v) / 100)
        })
        .collect();
    assert_eq!(got, want);
}

/// BT2.10 (a non-square substrate): a 6-wide, 8-high map keeps its own geometry —
/// `TacticalState::new` copies width 6, height 8, the exact row-major terrain (Rough at (1,2),
/// Water at (4,5)) and the LoS blockers ((2,6)); `board()` returns them unchanged; a unit at
/// the far corner (5,7) deploys while (7,5), (6,0) and (0,8) are `BadPosition`; and an AoE
/// aimed at the corner resolves on both units there.
/// Kills: width and height transposed in the position check or the stored state; tiles copied
/// column-major; `blocks_los` dropped or defaulted.
#[test]
fn a_non_square_map_keeps_its_own_width_height_and_tiles_bt2_10() {
    let at = |x: u8, y: u8| usize::from(y) * 6 + usize::from(x);
    let mut tiles = vec![
        TileDef {
            terrain: Terrain::Plain,
            elevation: 0,
            blocks_los: false,
        };
        48
    ];
    tiles[at(1, 2)].terrain = Terrain::Rough;
    tiles[at(4, 5)].terrain = Terrain::Water;
    tiles[at(2, 6)].blocks_los = true;
    let terrain: Vec<Terrain> = tiles.iter().map(|t| t.terrain).collect();
    let los: Vec<bool> = tiles.iter().map(|t| t.blocks_los).collect();
    let map = BattleMapDef {
        width: 6,
        height: 8,
        tiles,
        spawn_a: vec![c(1, 0), c(2, 0), c(3, 0)],
        spawn_b: vec![c(2, 7), c(3, 7), c(4, 7)],
    };
    let attacker = unit(
        1,
        Side::A,
        0,
        c(5, 6),
        water(
            100,
            CHIP_DEF,
            50,
            vec![light(10, Affinity::Fire, diamond(FfFilter::Enemies, 1))],
        ),
        100,
    );
    let corner = unit(
        2,
        Side::B,
        0,
        c(5, 7),
        water(100, CHIP_DEF, 40, vec![]),
        100,
    );
    let beside = unit(
        3,
        Side::B,
        1,
        c(4, 7),
        water(100, CHIP_DEF, 30, vec![]),
        100,
    );
    let mut st = TacticalState::new(
        BattleKind::Pvp,
        3,
        &map,
        vec![attacker.clone(), corner.clone(), beside],
    )
    .expect("(5,7) is on a 6-wide, 8-high map");
    assert_eq!((st.width, st.height), (6, 8));
    assert_eq!(st.terrain, terrain);
    assert_eq!(st.blocks_los, los);
    let board = st.board();
    assert_eq!((board.width, board.height), (6, 8));
    assert_eq!(board.terrain, terrain);
    assert_eq!(board.blocks_los, los);
    for off_map in [c(7, 5), c(6, 0), c(0, 8)] {
        let mut stray = corner.clone();
        stray.pos = off_map;
        assert_eq!(
            TacticalState::new(BattleKind::Pvp, 3, &map, vec![attacker.clone(), stray]).err(),
            Some(DeployError::BadPosition { id: 2 }),
            "{off_map:?}"
        );
    }
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(5, 7), &chart(), &design())
        .expect("the far corner is on the board");
    let hits: Vec<(u32, u16)> = executed_results(&out)
        .iter()
        .map(|r| (r.unit, r.damage))
        .collect();
    assert_eq!(hits, vec![(3, 1), (2, 1)]);
    assert_eq!(unit_of(&st, 2).cur_hp, 99);
}

/// BT2.3 (round-2 contract): a second TurnEnd after a Guard-granting one is a no-op — Guard
/// stays, `Ok(true)` (an auto-pass included), the state is unchanged — and TurnEnd on a unit
/// that never started is `Ok(false)` with its idle budget and the state untouched.
/// Kills: a repeated TurnEnd that recomputes Guard from the idle budget (0 AP) and revokes it;
/// Guard granted to a unit that never activated.
#[test]
fn a_repeated_or_unstarted_turn_end_changes_nothing_bt2_3() {
    let tu = design();
    let mut st = duel(BattleKind::Pvp, 3);
    ready(&mut st, 1);
    assert_eq!(turn_end(&mut st, 1, TurnEndCause::EndTurn, &tu), Ok(true));
    let ended = st.clone();
    assert_eq!(turn_end(&mut st, 1, TurnEndCause::EndTurn, &tu), Ok(true));
    assert_eq!(turn_end(&mut st, 1, TurnEndCause::AutoPass, &tu), Ok(true));
    assert_eq!(st, ended);
    assert_eq!(turn_end(&mut st, 2, TurnEndCause::EndTurn, &tu), Ok(false));
    assert_eq!(st, ended, "unit 2 never started: nothing changes");
    let idle = unit_of(&st, 2);
    assert_eq!((idle.guard, idle.budget), (false, TurnBudget::default()));
}

/// BT2.3: Guard belongs to the unit that earned it — A's 1 and B's 2 each end Guarded; then A's
/// 3 starts, Lights B's 4 and ends unguarded, and both Guards still hold; each Guarded unit
/// takes ×3/4 in the pipeline (a lethal-defence Light at variance 100: d0 9 → d2 6).
/// Kills: a TurnStart, TurnEnd or attack that clears or recomputes OTHER units' Guard.
#[test]
fn guard_belongs_to_the_unit_that_earned_it_bt2_3() {
    let tu = design();
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(0, 0),
                water(50, LETHAL_DEF, 60, vec![]),
                50,
            ),
            unit(
                3,
                Side::A,
                1,
                c(2, 3),
                water(100, CHIP_DEF, 50, vec![light(10, Affinity::Fire, melee())]),
                100,
            ),
            unit(
                2,
                Side::B,
                0,
                c(6, 0),
                water(50, LETHAL_DEF, 40, vec![]),
                50,
            ),
            unit(
                4,
                Side::B,
                1,
                c(3, 3),
                water(100, CHIP_DEF, 30, vec![]),
                100,
            ),
        ],
    );
    for id in [1, 2] {
        ready(&mut st, id);
        assert_eq!(
            turn_end(&mut st, id, TurnEndCause::EndTurn, &tu),
            Ok(true),
            "unit {id}"
        );
    }
    ready(&mut st, 3);
    resolve_attack(&mut st, 3, 10, c(3, 3), &chart(), &tu).expect("A's 3 Lights B's 4");
    assert_eq!(turn_end(&mut st, 3, TurnEndCause::EndTurn, &tu), Ok(false));
    assert!(unit_of(&st, 1).guard, "A's Guard survives");
    assert!(unit_of(&st, 2).guard, "B's Guard survives");
    assert!(!unit_of(&st, 3).guard);
    let striker = unit(
        9,
        Side::A,
        2,
        c(5, 0),
        water(100, CHIP_DEF, 10, vec![]),
        100,
    );
    for id in [1, 2] {
        let trace = damage_pipeline(
            &striker,
            unit_of(&st, id),
            &light(10, Affinity::Fire, melee()),
            &chart(),
            false,
            SURE,
            &tu,
        );
        assert_eq!((trace.d0, trace.d2, trace.d3), (9, 6, 6), "unit {id}");
    }
}

/// BT2.10 (hostile state): `resolve_attack` validates the tuning FIRST — a zero Guard
/// denominator, a zero flank denominator and a zero AP turn are each `Tuning(..)`, ahead of
/// every other check (even a 0-HP actor) — with the state byte-identical and nothing drawn.
/// Kills: an unvalidated tuning reaching `apply_guard`/`apply_flank` (a divide-by-zero panic);
/// the tuning checked after the actor.
#[test]
fn an_unusable_tuning_is_refused_before_anything_else_bt2_10() {
    type Edit = fn(&mut TacticsTuning);
    let cases: [(Edit, TuningError); 3] = [
        (|t| t.guard_den = 0, TuningError::ZeroGuardDen),
        (|t| t.flank_den = 0, TuningError::ZeroFlankDen),
        (|t| t.ap_turn = 0, TuningError::ZeroApTurn),
    ];
    for (edit, want) in cases {
        let bad = perturb(edit);
        let mut st = duel(BattleKind::Pvp, 5);
        ready(&mut st, 1);
        for actor_hp in [100u16, 0] {
            st.unit_mut(1).expect("unit 1").cur_hp = actor_hp;
            let before = st.clone();
            assert_eq!(
                resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &bad),
                Err(ResolveError::Tuning(want)),
                "actor at {actor_hp} HP"
            );
            assert_eq!(st, before, "{want:?} must leave the battle byte-identical");
        }
    }
}

/// BT2.10 (hostile state): a unit hand-edited past `TacticalState::new` is refused as `BadUnit`
/// with the state byte-identical and nothing drawn — the actor (checked after can-act and
/// BEFORE its skill), and every target in target order (checked after geometry and BEFORE the
/// AP): the first bad target in (y, x, id) order is the one named.
/// Kills: `calc_damage` reached with defence 0; an over-max actor resolving; targets left
/// unchecked; targets checked in units or id order.
#[test]
fn a_hand_edited_invalid_unit_is_refused_untouched_bt2_10() {
    let started = || {
        let mut st = duel(BattleKind::Pvp, 5);
        ready(&mut st, 1);
        st
    };
    let mut soft = started();
    soft.unit_mut(2).expect("unit 2").kit.stats.defense = 0;
    assert_rejected(
        soft,
        1,
        10,
        c(3, 3),
        ResolveError::BadUnit(DeployError::ZeroDefense { id: 2 }),
    );
    let mut swollen = started();
    swollen.unit_mut(1).expect("unit 1").cur_hp = 101;
    let over = ResolveError::BadUnit(DeployError::HpAboveMax {
        id: 1,
        cur_hp: 101,
        max_hp: 100,
    });
    assert_rejected(swollen.clone(), 1, 10, c(3, 3), over);
    assert_rejected(swollen, 1, 99, c(3, 3), over);

    let mut idle_soft = duel(BattleKind::Pvp, 5);
    idle_soft.unit_mut(2).expect("unit 2").kit.stats.defense = 0;
    assert_rejected(
        idle_soft.clone(),
        1,
        10,
        c(5, 3),
        ResolveError::Geometry(GeometryError::OutOfRange { distance: 3 }),
    );
    assert_rejected(
        idle_soft,
        1,
        10,
        c(3, 3),
        ResolveError::BadUnit(DeployError::ZeroDefense { id: 2 }),
    );

    let mut st = state(
        BattleKind::Pvp,
        5,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(3, 1),
                water(
                    100,
                    CHIP_DEF,
                    50,
                    vec![light(10, Affinity::Fire, diamond(FfFilter::Enemies, 2))],
                ),
                100,
            ),
            unit(
                4,
                Side::B,
                0,
                c(4, 3),
                water(100, CHIP_DEF, 40, vec![]),
                100,
            ),
            unit(
                5,
                Side::B,
                1,
                c(2, 3),
                water(100, CHIP_DEF, 30, vec![]),
                100,
            ),
            unit(
                6,
                Side::B,
                2,
                c(3, 3),
                water(100, CHIP_DEF, 20, vec![]),
                100,
            ),
        ],
    );
    ready(&mut st, 1);
    st.unit_mut(4).expect("unit 4").kit.stats.defense = 0;
    st.unit_mut(5).expect("unit 5").cur_hp = 101;
    assert_rejected(
        st,
        1,
        10,
        c(3, 3),
        ResolveError::BadUnit(DeployError::HpAboveMax {
            id: 5,
            cur_hp: 101,
            max_hp: 100,
        }),
    );
}

/// BT2.10 (hostile state, round-2 contract): `damage_pipeline` against a target already at
/// 0 HP with First-Stand still set never saves or revives it — applied 0, hp_after 0, no
/// StoodGround — and never panics.
/// Kills: a save that computes `cur_hp − 1` on a corpse (an underflow panic) or lifts it to 1 HP.
#[test]
fn the_pipeline_never_revives_a_zero_hp_target_bt2_10() {
    let mut corpse = plant_target(14);
    corpse.cur_hp = 0;
    assert!(corpse.first_stand);
    let trace = damage_pipeline(
        &fire_attacker(),
        &corpse,
        &fire40(),
        &chart(),
        false,
        SURE,
        &design(),
    );
    assert_eq!(
        (trace.hit, trace.applied, trace.hp_after, trace.stood_ground),
        (true, 0, 0, false)
    );
}
