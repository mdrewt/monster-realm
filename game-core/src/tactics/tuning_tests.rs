//! bt-2 gating tests — `tactics::tuning`: the `TacticsTuning` constants (BT2.1) and the
//! `BattleKind` ruleset selector (BT2.8).
//!
//! The expected numbers are the design document's (§2.1 table, §2.1.2 Guard, §2.3 clock,
//! §2.4 flank, §3.7 wild bounds, §6.4 Surge), restated here by hand. Test names end in the
//! criterion tag `_bt2_<k>`; the ledger CHECKs filter on it.

use super::resolve_tests::perturb;
use super::tuning::{BattleKind, TacticsTuning, TuningError};

/// BT2.1: `TacticsTuning::DESIGN` is a valid tuning carrying the design's numbers, field by
/// field (AP 6, Move 2 per stride, 2 strides, disengage +1, Light 2, Heavy 4, Exert +2, Item 3,
/// Recruit 6, Flee 6, EndTurn 0, Guard at 2 AP for 3/4, flank 5/4, Surge from round 9 at 5 %,
/// the wild cap 30 and the clock constants).
/// Kills: a mistyped design constant; a `validate` that rejects the design itself.
#[test]
fn the_design_tuning_is_valid_and_carries_every_design_number_bt2_1() {
    let design = TacticsTuning::DESIGN;
    assert_eq!(design.validate(), Ok(()));
    assert_eq!(
        design,
        TacticsTuning {
            ap_turn: 6,
            move_stride_cost: 2,
            max_strides_per_turn: 2,
            disengage_tax: 1,
            light_cost: 2,
            heavy_cost: 4,
            exert_surcharge: 2,
            item_cost: 3,
            recruit_cost: 6,
            flee_cost: 6,
            end_turn_cost: 0,
            guard_min_ap: 2,
            guard_num: 3,
            guard_den: 4,
            flank_num: 5,
            flank_den: 4,
            surge_start_round: 9,
            surge_pct_per_round: 5,
            wild_round_cap: 30,
            pvp_window_ms: 30_000,
            pve_window_ms: 300_000,
            pvp_deploy_ms: 45_000,
            pve_deploy_ms: 300_000,
            max_windows_per_turn: 3,
            autopass_forfeit: 4,
            pad_cap_ms: 5_000,
        }
    );
}

/// BT2.1 (plan A12): `validate` rejects a zero Guard denominator, a zero flank denominator and
/// a zero AP turn, each from its own perturbation, first failure in declaration order; 1 is
/// accepted for each.
/// Kills: a `validate` that is always `Ok`; one that checks the fields in another order; one
/// that rejects 1 (an off-by-one `< 2`).
#[test]
fn validate_rejects_each_unusable_value_in_declaration_order_bt2_1() {
    assert_eq!(
        perturb(|t| t.guard_den = 0).validate(),
        Err(TuningError::ZeroGuardDen)
    );
    assert_eq!(
        perturb(|t| t.flank_den = 0).validate(),
        Err(TuningError::ZeroFlankDen)
    );
    assert_eq!(
        perturb(|t| t.ap_turn = 0).validate(),
        Err(TuningError::ZeroApTurn)
    );
    let all_three = perturb(|t| {
        t.guard_den = 0;
        t.flank_den = 0;
        t.ap_turn = 0;
    });
    assert_eq!(all_three.validate(), Err(TuningError::ZeroGuardDen));
    let last_two = perturb(|t| {
        t.flank_den = 0;
        t.ap_turn = 0;
    });
    assert_eq!(last_two.validate(), Err(TuningError::ZeroFlankDen));
    let ones = perturb(|t| {
        t.guard_den = 1;
        t.flank_den = 1;
        t.ap_turn = 1;
    });
    assert_eq!(ones.validate(), Ok(()));
}

/// BT2.1: the design tuning survives a RON round-trip (bt-6 loads it from
/// `tactics_tuning.ron`) and the loaded value still validates.
/// Kills: a serde shape that drops or renames a field.
#[test]
fn the_design_tuning_round_trips_through_ron_and_still_validates_bt2_1() {
    let text = ron::to_string(&TacticsTuning::DESIGN).expect("the tuning serializes");
    let back: TacticsTuning = ron::from_str(&text).expect("the tuning parses back");
    assert_eq!(back, TacticsTuning::DESIGN);
    assert_eq!(back.validate(), Ok(()));
}

/// BT2.1: a misspelt tuning key is a load error (`deny_unknown_fields`), never a silently
/// ignored constant; the same text without it loads and validates.
/// Kills: dropping `deny_unknown_fields`, so a typo in the content file leaves the design value
/// in force unnoticed.
#[test]
fn an_unknown_tuning_key_is_a_load_error_not_an_ignored_constant_bt2_1() {
    let text = ron::to_string(&TacticsTuning::DESIGN).expect("the tuning serializes");
    let body = text
        .trim_end()
        .strip_suffix(')')
        .expect("a RON struct ends with a closing paren");
    let misspelt = format!("{body},light_cots:3)");
    assert!(
        ron::from_str::<TacticsTuning>(&misspelt).is_err(),
        "an unknown key must not load: {misspelt}"
    );
    let loaded: TacticsTuning = ron::from_str(&text).expect("the clean text loads");
    assert_eq!(loaded.validate(), Ok(()));
}

/// BT2.8 (plan A13): the PvP ruleset (Surge, adjudication) is Pvp and Practice; Wild never.
/// Kills: Practice treated as PvE (no Surge in practice matches); Wild treated as PvP.
#[test]
fn only_pvp_and_practice_use_the_pvp_ruleset_bt2_8() {
    assert!(!BattleKind::Wild.uses_pvp_rules());
    assert!(BattleKind::Pvp.uses_pvp_rules());
    assert!(BattleKind::Practice.uses_pvp_rules());
}
