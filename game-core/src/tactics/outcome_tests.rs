//! bt-2 gating tests — `tactics::outcome`: BT2.9 (the adjudication tuple at step START, the
//! battle-end check, `end_battle`, `settle`, double wipes through an attack and through Surge)
//! and the KO-sweep half of BT2.10.
//!
//! Each adjudication vector ties every earlier tuple element and makes a later element point
//! the OTHER way, so a reordered tuple fails. The coin oracle is `crate::tick_seed(x, 0, 0) & 1`
//! (0 → A); hand vectors use `splitmix64(0)` (low bit 1), `splitmix64(1)` (1), `splitmix64(6)`
//! (0) and `splitmix64(0x1_8B9E_F457)` = `tick_seed(0xDEAD_BEEF, 0x1234_5678, 0x9ABC_DEF0)` (0).
//! Test names end in the criterion tag `_bt2_<k>`.

use crate::combat::types::BattleOutcome;
use crate::monster::types::Affinity;

use super::geometry::{FfFilter, Side};
use super::initiative::TIE_SALT;
use super::outcome::{
    adjudicate, check_battle_end, end_battle, settle, sweep_kos, Adjudication, BattleEndHow,
    StepSnapshot,
};
use super::resolve::{resolve_attack, TacticalEvent, UnitState};
use super::resolve_tests::{
    c, chart, coin, design, diamond, duel, heavy, ready, state, unit, unit_of, water, CHIP_DEF,
    LETHAL_DEF,
};
use super::tuning::BattleKind;
use super::upkeep::run_upkeep;

fn snap(hp_pct: [u32; 2], conscious: [u8; 2]) -> StepSnapshot {
    StepSnapshot { hp_pct, conscious }
}

// ===========================================================================
// BT2.9 — the tuple
// ===========================================================================

/// BT2.9: a higher Σ HP percent decides first — even against fewer conscious units and less
/// damage dealt — for either side.
/// Kills: conscious count or damage dealt ranked ahead of HP percent; the comparison inverted.
#[test]
fn a_higher_hp_percent_wins_adjudication_whatever_follows_bt2_9() {
    assert_eq!(
        adjudicate(&snap([150, 149], [1, 3]), [0, 900], 0, 1),
        (Side::A, Adjudication::HpPercent)
    );
    assert_eq!(
        adjudicate(&snap([99, 149], [3, 1]), [900, 0], 0, 1),
        (Side::B, Adjudication::HpPercent)
    );
}

/// BT2.9: with HP percent tied, more conscious units decide — even against the damage dealt.
/// Kills: damage dealt ranked ahead of conscious units.
#[test]
fn more_conscious_units_decide_when_hp_percent_ties_bt2_9() {
    assert_eq!(
        adjudicate(&snap([100, 100], [1, 2]), [900, 0], 0, 1),
        (Side::B, Adjudication::Conscious)
    );
    assert_eq!(
        adjudicate(&snap([100, 100], [2, 1]), [0, 900], 0, 1),
        (Side::A, Adjudication::Conscious)
    );
}

/// BT2.9: with HP percent and conscious units tied, higher cumulative attack damage decides
/// (at the top of the u32 range too).
/// Kills: the coin ranked ahead of damage dealt; the comparison inverted.
#[test]
fn attack_damage_dealt_decides_when_hp_and_conscious_tie_bt2_9() {
    let tied = snap([0, 0], [0, 0]);
    assert_eq!(
        adjudicate(&tied, [7, 6], 0, 1),
        (Side::A, Adjudication::DamageDealt)
    );
    assert_eq!(
        adjudicate(&tied, [6, 7], 0, 1),
        (Side::B, Adjudication::DamageDealt)
    );
    assert_eq!(
        adjudicate(&snap([40, 40], [1, 1]), [u32::MAX, u32::MAX - 1], 0, 1),
        (Side::A, Adjudication::DamageDealt)
    );
}

/// BT2.9: with everything tied the coin is `splitmix64(seed ^ round) & 1` (0 → A, 1 → B):
/// hand vectors seed ^ round = 0 → B, 6 → A, 1 → B, 0x1_8B9E_F457 → A; and seeds/rounds where
/// the salted (`^ 0x5EED`), bare-seed and `seed + round` coins all point the other way.
/// Kills: the initiative coin reused; the round ignored; the round added; the bit inverted.
#[test]
fn the_coin_is_splitmix64_of_seed_xor_round_bt2_9() {
    let tied = snap([50, 50], [1, 1]);
    let damage = [3, 3];
    assert_eq!(
        adjudicate(&tied, damage, 9, 9),
        (Side::B, Adjudication::Coin)
    );
    assert_eq!(
        adjudicate(&tied, damage, 5, 3),
        (Side::A, Adjudication::Coin)
    );
    assert_eq!(
        adjudicate(&tied, damage, 15, 14),
        (Side::B, Adjudication::Coin)
    );
    assert_eq!(
        adjudicate(&tied, damage, 0x1_8B9E_F458, 15),
        (Side::A, Adjudication::Coin)
    );
    assert_eq!(
        adjudicate(&tied, damage, 0, 0),
        (Side::B, Adjudication::Coin)
    );
    for want in [Side::A, Side::B] {
        let picks: Vec<(u64, u16)> = (0u64..)
            .flat_map(|s| (1u16..=20).map(move |r| (s, r)))
            .filter(|&(s, r)| {
                let round = u64::from(r);
                coin(s ^ round) == want
                    && coin(s ^ TIE_SALT) != want
                    && coin(s) != want
                    && coin(s.wrapping_add(round)) != want
            })
            .take(3)
            .collect();
        assert_eq!(picks.len(), 3);
        for (seed, round) in picks {
            assert_eq!(
                adjudicate(&tied, damage, seed, round),
                (want, Adjudication::Coin),
                "seed {seed} round {round}"
            );
        }
    }
}

// ===========================================================================
// BT2.9 — the snapshot and the battle-end check
// ===========================================================================

/// BT2.9 (judgement 3): the snapshot floors EACH unit's `cur_hp × 100 / max_hp` before summing
/// (50/100 + 99/100 = 149, not 74; 1/3 + 2/3 = 33 + 66 = 99, not 50), counts only Active units
/// (a Fainted unit with HP left and a Recruited unit add nothing), and counts conscious units;
/// a 0-HP Active unit adds 0 and is not conscious.
/// Kills: one floor over the summed fraction; Fainted/Recruited units counted; a 0-HP unit
/// counted as conscious.
#[test]
fn the_snapshot_floors_each_unit_and_counts_only_active_units_bt2_9() {
    let mut st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(1, Side::A, 0, c(0, 0), water(100, CHIP_DEF, 50, vec![]), 50),
            unit(2, Side::A, 1, c(0, 2), water(100, CHIP_DEF, 45, vec![]), 99),
            unit(3, Side::A, 2, c(0, 4), water(100, CHIP_DEF, 40, vec![]), 40),
            unit(4, Side::B, 0, c(6, 0), water(3, CHIP_DEF, 35, vec![]), 1),
            unit(5, Side::B, 1, c(6, 2), water(3, CHIP_DEF, 30, vec![]), 2),
            unit(6, Side::B, 2, c(6, 4), water(100, CHIP_DEF, 25, vec![]), 60),
        ],
    );
    st.unit_mut(3).expect("unit 3").state = UnitState::Fainted;
    st.unit_mut(6).expect("unit 6").state = UnitState::Recruited;
    assert_eq!(
        StepSnapshot::capture(&st),
        StepSnapshot {
            hp_pct: [149, 99],
            conscious: [2, 2]
        }
    );
    st.unit_mut(5).expect("unit 5").cur_hp = 0;
    assert_eq!(
        StepSnapshot::capture(&st),
        StepSnapshot {
            hp_pct: [149, 33],
            conscious: [2, 1]
        }
    );
}

/// BT2.9: both sides alive → no end; exactly one side without a conscious unit → the other side
/// wins by `SideEmpty` (a 0-HP Active unit counts as empty).
/// Kills: the winner inverted; a 0-HP unit keeping its side alive.
#[test]
fn the_battle_end_check_names_the_surviving_side_bt2_9() {
    let st = duel(BattleKind::Pvp, 1);
    let start = StepSnapshot::capture(&st);
    assert_eq!(check_battle_end(&st, &start), None);
    let mut a_down = duel(BattleKind::Pvp, 1);
    a_down.unit_mut(1).expect("unit 1").cur_hp = 0;
    assert_eq!(
        check_battle_end(&a_down, &start),
        Some((BattleOutcome::SideBWins, BattleEndHow::SideEmpty))
    );
    let mut b_down = duel(BattleKind::Pvp, 1);
    {
        let u = b_down.unit_mut(2).expect("unit 2");
        u.cur_hp = 0;
        u.state = UnitState::Fainted;
    }
    assert_eq!(
        check_battle_end(&b_down, &start),
        Some((BattleOutcome::SideAWins, BattleEndHow::SideEmpty))
    );
}

/// BT2.9: both sides empty under the PvP ruleset (Pvp and Practice) is adjudicated from the
/// step-START snapshot it is handed (A 80 vs B 40 → A by HP percent); the post-damage snapshot
/// (0/0, 0/0) would have fallen through to damage dealt and given B.
/// Kills: a snapshot re-captured inside the check; a double wipe called for either side by
/// default.
#[test]
fn a_pvp_double_wipe_is_adjudicated_from_the_step_start_snapshot_bt2_9() {
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        let mut st = duel(kind, 1);
        st.attack_damage_dealt = [0, 50];
        st.unit_mut(1).expect("unit 1").cur_hp = 0;
        st.unit_mut(2).expect("unit 2").cur_hp = 0;
        let start = snap([80, 40], [1, 1]);
        assert_eq!(
            check_battle_end(&st, &start),
            Some((
                BattleOutcome::SideAWins,
                BattleEndHow::Adjudicated(Adjudication::HpPercent)
            )),
            "{kind:?}"
        );
        let after = StepSnapshot::capture(&st);
        assert_eq!(after, snap([0, 0], [0, 0]));
        assert_eq!(
            check_battle_end(&st, &after),
            Some((
                BattleOutcome::SideBWins,
                BattleEndHow::Adjudicated(Adjudication::DamageDealt)
            )),
            "{kind:?}"
        );
    }
}

/// BT2.9: a wild double wipe follows the standing r2 ruling — `SideBWins` by `FixedOrder` —
/// whatever the snapshot says; outcomes stay SideAWins | SideBWins (never a Draw or Fled).
/// Kills: adjudication applied to wild battles; a Fled outcome for a mutual wipe.
#[test]
fn a_wild_double_wipe_follows_the_fixed_order_ruling_bt2_9() {
    let mut st = duel(BattleKind::Wild, 1);
    st.unit_mut(1).expect("unit 1").cur_hp = 0;
    st.unit_mut(2).expect("unit 2").cur_hp = 0;
    assert_eq!(
        check_battle_end(&st, &snap([80, 40], [1, 1])),
        Some((BattleOutcome::SideBWins, BattleEndHow::FixedOrder))
    );
}

/// BT2.9: `end_battle` records the outcome and returns its `BattleEnd`; a decided battle is
/// never overwritten.
/// Kills: a second end_battle replacing the first outcome.
#[test]
fn end_battle_records_an_outcome_once_bt2_9() {
    let mut st = duel(BattleKind::Pvp, 1);
    assert_eq!(
        end_battle(&mut st, BattleOutcome::SideBWins, BattleEndHow::SideEmpty),
        TacticalEvent::BattleEnd {
            outcome: BattleOutcome::SideBWins,
            how: BattleEndHow::SideEmpty
        }
    );
    assert_eq!(st.outcome, BattleOutcome::SideBWins);
    let _ = end_battle(
        &mut st,
        BattleOutcome::SideAWins,
        BattleEndHow::Adjudicated(Adjudication::Coin),
    );
    assert_eq!(st.outcome, BattleOutcome::SideBWins);
}

/// BT2.9 (plan A8): `settle` is the sweep's events then the battle end — `Ko`, `QueueVoided`,
/// `BattleEnd` — and nothing when nobody is down.
/// Kills: BattleEnd before the sweep; settle that only sweeps.
#[test]
fn settle_sweeps_then_ends_the_battle_bt2_9() {
    let mut st = duel(BattleKind::Pvp, 1);
    st.queued = vec![2];
    let start = StepSnapshot::capture(&st);
    st.unit_mut(2).expect("unit 2").cur_hp = 0;
    assert_eq!(
        settle(&mut st, &start),
        vec![
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::QueueVoided { unit: 2 },
            TacticalEvent::BattleEnd {
                outcome: BattleOutcome::SideAWins,
                how: BattleEndHow::SideEmpty
            },
        ]
    );
    assert_eq!(unit_of(&st, 2).state, UnitState::Fainted);
    assert_eq!(st.outcome, BattleOutcome::SideAWins);
    assert_eq!(st.initiative, vec![1]);
    assert!(st.queued.is_empty());

    let mut calm = duel(BattleKind::Pvp, 1);
    let start = StepSnapshot::capture(&calm);
    assert!(settle(&mut calm, &start).is_empty());
    assert_eq!(calm.outcome, BattleOutcome::Ongoing);
}

/// BT2.9: a double wipe inside ONE attack (Practice; A's last unit splashes itself and B's last
/// unit with an `All` Heavy) is adjudicated from the PRE-attack snapshot: both at 5/10 (50 %)
/// and one conscious each, so cumulative attack damage decides — A dealt 5 to B (its own
/// self-damage never counts) — A wins by `DamageDealt`.
/// Kills: no adjudication after an attack; self-damage counted for A; the post-attack snapshot.
#[test]
fn a_double_wipe_inside_one_attack_is_adjudicated_from_the_pre_attack_snapshot_bt2_9() {
    let splash = heavy(10, Affinity::Fire, 75, diamond(FfFilter::All, 1));
    let mut st = state(
        BattleKind::Practice,
        19,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(2, 3),
                water(10, LETHAL_DEF, 50, vec![splash]),
                5,
            ),
            unit(2, Side::B, 0, c(3, 3), water(10, LETHAL_DEF, 40, vec![]), 5),
        ],
    );
    st.unit_mut(2).expect("unit 2").first_stand = false;
    ready(&mut st, 1);
    let out = resolve_attack(&mut st, 1, 10, c(3, 3), &chart(), &design()).expect("a valid splash");
    assert_eq!(out.ap_spent, 4);
    assert_eq!(
        out.events[1..],
        [
            TacticalEvent::Ko { unit: 1 },
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::BattleEnd {
                outcome: BattleOutcome::SideAWins,
                how: BattleEndHow::Adjudicated(Adjudication::DamageDealt)
            },
        ]
    );
    assert_eq!(st.attack_damage_dealt, [5, 0]);
    assert_eq!(st.outcome, BattleOutcome::SideAWins);
}

/// BT2.9 (plan A8): a double wipe by Surge is adjudicated from the PRE-upkeep snapshot — A at
/// 1/20 (5 %) against B at 1/10 (10 %) → B by HP percent, although A has dealt more attack
/// damage (which a post-Surge snapshot, 0/0 and 0/0, would have fallen through to) — and the
/// round does not advance.
/// Kills: the snapshot taken after the Surge; the upkeep continuing past the battle end.
#[test]
fn a_double_wipe_by_surge_is_adjudicated_from_the_pre_upkeep_snapshot_bt2_9() {
    let mut st = state(
        BattleKind::Pvp,
        23,
        vec![
            unit(1, Side::A, 0, c(0, 0), water(20, CHIP_DEF, 50, vec![]), 1),
            unit(2, Side::B, 0, c(6, 6), water(10, CHIP_DEF, 40, vec![]), 1),
        ],
    );
    st.round = 9;
    st.attack_damage_dealt = [7, 0];
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::Surge {
                round: 9,
                unit: 1,
                amount: 1
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 2,
                amount: 1
            },
            TacticalEvent::Ko { unit: 1 },
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::BattleEnd {
                outcome: BattleOutcome::SideBWins,
                how: BattleEndHow::Adjudicated(Adjudication::HpPercent)
            },
        ]
    );
    assert_eq!(st.round, 9);
    assert_eq!(st.outcome, BattleOutcome::SideBWins);
}

// ===========================================================================
// BT2.10 — the KO sweep
// ===========================================================================

/// BT2.10: the sweep faints every Active 0-HP unit in the canonical units order (A then B, by
/// slot — not initiative or id order), removes each from the initiative and `queued`, emits
/// `Ko` and then `QueueVoided` only for a unit that held a READY plan, does not end the battle
/// by itself, and finds nothing a second time.
/// Kills: a Ko order following initiative or ids; a QueueVoided for an unqueued unit; a sweep
/// that re-faints the dead.
#[test]
fn the_ko_sweep_faints_zero_hp_units_in_units_order_and_voids_their_plans_bt2_10() {
    let mut st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(5, Side::A, 0, c(0, 0), water(50, CHIP_DEF, 10, vec![]), 50),
            unit(3, Side::A, 1, c(0, 2), water(50, CHIP_DEF, 20, vec![]), 50),
            unit(4, Side::B, 0, c(6, 0), water(50, CHIP_DEF, 30, vec![]), 50),
            unit(1, Side::B, 1, c(6, 2), water(50, CHIP_DEF, 40, vec![]), 50),
        ],
    );
    assert_eq!(st.initiative, vec![1, 4, 3, 5]);
    st.queued = vec![1, 3];
    for id in [3, 4, 1] {
        st.unit_mut(id).expect("the unit").cur_hp = 0;
    }
    assert_eq!(
        sweep_kos(&mut st),
        vec![
            TacticalEvent::Ko { unit: 3 },
            TacticalEvent::QueueVoided { unit: 3 },
            TacticalEvent::Ko { unit: 4 },
            TacticalEvent::Ko { unit: 1 },
            TacticalEvent::QueueVoided { unit: 1 },
        ]
    );
    for id in [3, 4, 1] {
        assert_eq!(unit_of(&st, id).state, UnitState::Fainted, "unit {id}");
    }
    assert_eq!(st.initiative, vec![5]);
    assert!(st.queued.is_empty());
    assert_eq!(st.outcome, BattleOutcome::Ongoing);
    assert!(sweep_kos(&mut st).is_empty());
}

/// BT2.10: a non-Active 0-HP unit (Recruited) is not swept, and an Active unit with HP is
/// untouched.
/// Kills: a sweep keyed on `cur_hp == 0` alone (it would re-Faint a recruited unit).
#[test]
fn the_ko_sweep_touches_only_active_units_at_zero_hp_bt2_10() {
    let mut st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(1, Side::A, 0, c(0, 0), water(30, CHIP_DEF, 60, vec![]), 30),
            unit(2, Side::A, 1, c(0, 2), water(50, CHIP_DEF, 20, vec![]), 50),
            unit(3, Side::B, 0, c(6, 0), water(50, CHIP_DEF, 30, vec![]), 50),
        ],
    );
    {
        let u = st.unit_mut(2).expect("unit 2");
        u.state = UnitState::Recruited;
        u.cur_hp = 0;
    }
    st.unit_mut(1).expect("unit 1").cur_hp = 0;
    assert_eq!(sweep_kos(&mut st), vec![TacticalEvent::Ko { unit: 1 }]);
    assert_eq!(unit_of(&st, 2).state, UnitState::Recruited);
    assert_eq!(unit_of(&st, 3).state, UnitState::Active);
}
