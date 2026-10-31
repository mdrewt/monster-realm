//! bt-2 gating tests — `tactics::upkeep`: BT2.7 (the fixed upkeep order, status expiry by the
//! carried M14 rules, the battle-end check after every entry, the wild round cap), BT2.8 (Surge
//! and the termination bound, with the A1 erratum), and the upkeep halves of BT2.3 (Guard does
//! not soften ticks or Surge) and BT2.6 (First-Stand does not stop them).
//!
//! Expected amounts are hand-derived: Poison max_hp/8, Burn max_hp/16 (min 1), Surge
//! `max_hp × 5 × (r − 8) / 100` (min 1) at the design tuning. Freeze thaw rolls and coins are
//! recomputed from `crate::tick_seed(x, 0, 0)` (seeds are searched for so the roll is what the
//! test needs). Test names end in the criterion tag `_bt2_<k>`.

use proptest::prelude::*;

use crate::combat::status::{apply_post_turn_effects, BattleStatusStore};
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, StatusEffect,
};
use crate::monster::types::Affinity;

use super::economy::TurnEndCause;
use super::geometry::Side;
use super::outcome::{Adjudication, BattleEndHow};
use super::resolve::{
    can_act, resolve_attack, turn_end, turn_start, ActError, TacticalEvent, TacticalUnit, UnitState,
};
use super::resolve_tests::{
    c, chart, design, duel, light, melee, mix, perturb, ready, stat_block, state, unit, unit_of,
    water, CHIP_DEF, LETHAL_DEF,
};
use super::tuning::BattleKind;
use super::upkeep::{run_upkeep, status_tick_damage, surge_damage};

/// `u` afflicted with `status`.
fn sick(mut u: TacticalUnit, status: StatusEffect) -> TacticalUnit {
    u.status = Some(status);
    u
}

/// A plain chip-defence unit of `max_hp` at `cur_hp` with `speed`, on its side's column.
fn body(id: u32, side: Side, slot: u8, max_hp: u16, cur_hp: u16, speed: u16) -> TacticalUnit {
    let x = if side == Side::A { 0 } else { 6 };
    unit(
        id,
        side,
        slot,
        c(x, 2 * slot),
        water(max_hp, CHIP_DEF, speed, vec![]),
        cur_hp,
    )
}

// ===========================================================================
// BT2.7 — the upkeep order
// ===========================================================================

/// BT2.7: one PvP upkeep at round 9 runs, in order: status ticks in this round's initiative
/// order (11 Burn 10, 14 Poison 5 — KO'd, 10 Poison 12) → Surge on every conscious unit in
/// initiative order (none for 14) → the KO sweep in units order (14 with its plan voided, then
/// 15, which the Surge took from 1 HP) → expiry in initiative order (13's Freeze thaws on a
/// roll ≥ 80, 12's Sleep 1 is cured) → round 10 with the order rebuilt from the conscious units
/// (12's mid-round speed change now applies). The KO'd units' statuses are not ticked down.
/// Kills: any step out of order; ticks or Surge in units/id order; Surge on a unit the ticks
/// KO'd; expiry run for the dead; the rebuild before the increment or not at all.
#[test]
fn upkeep_runs_ticks_surge_sweep_expiry_then_the_next_round_bt2_7() {
    let mut st = state(
        BattleKind::Pvp,
        0,
        vec![
            sick(
                body(12, Side::A, 0, 120, 120, 50),
                StatusEffect::Sleep { turns_remaining: 1 },
            ),
            sick(body(14, Side::A, 1, 40, 5, 80), StatusEffect::Poison),
            sick(body(10, Side::A, 2, 96, 90, 70), StatusEffect::Poison),
            sick(body(11, Side::B, 0, 160, 150, 90), StatusEffect::Burn),
            sick(body(13, Side::B, 1, 200, 200, 60), StatusEffect::Freeze),
            sick(
                body(15, Side::B, 2, 100, 1, 75),
                StatusEffect::Sleep { turns_remaining: 1 },
            ),
        ],
    );
    assert_eq!(st.initiative, vec![11, 14, 15, 10, 13, 12]);
    st.round = 9;
    st.action_seq = 40;
    st.seed = (0u64..)
        .find(|&s| mix(s ^ 40) % 100 >= 80)
        .expect("a seed whose thaw roll at seq 40 is at least 80");
    st.queued = vec![14, 10];
    st.unit_mut(12).expect("unit 12").kit.stats.speed = 100;

    let events = run_upkeep(&mut st, &design());
    assert_eq!(events.len(), 13, "{events:?}");
    assert_eq!(
        events[..11],
        [
            TacticalEvent::StatusTick {
                unit: 11,
                status: StatusEffect::Burn,
                amount: 10
            },
            TacticalEvent::StatusTick {
                unit: 14,
                status: StatusEffect::Poison,
                amount: 5
            },
            TacticalEvent::StatusTick {
                unit: 10,
                status: StatusEffect::Poison,
                amount: 12
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 11,
                amount: 8
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 15,
                amount: 5
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 10,
                amount: 4
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 13,
                amount: 10
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 12,
                amount: 6
            },
            TacticalEvent::Ko { unit: 14 },
            TacticalEvent::QueueVoided { unit: 14 },
            TacticalEvent::Ko { unit: 15 },
        ]
    );
    assert_eq!(
        events[11],
        TacticalEvent::StatusCured {
            unit: 13,
            status: StatusEffect::Freeze
        }
    );
    assert!(
        matches!(
            events[12],
            TacticalEvent::StatusCured {
                unit: 12,
                status: StatusEffect::Sleep { .. }
            }
        ),
        "{:?}",
        events[12]
    );

    assert_eq!(st.round, 10);
    assert_eq!(st.initiative, vec![12, 11, 10, 13]);
    assert_eq!(st.action_seq, 41, "exactly one thaw draw");
    assert_eq!(st.queued, vec![10]);
    let after = |id: u32| {
        let u = unit_of(&st, id);
        (u.cur_hp, u.status, u.state)
    };
    assert_eq!(
        after(11),
        (132, Some(StatusEffect::Burn), UnitState::Active)
    );
    assert_eq!(
        after(10),
        (74, Some(StatusEffect::Poison), UnitState::Active)
    );
    assert_eq!(after(13), (190, None, UnitState::Active));
    assert_eq!(after(12), (114, None, UnitState::Active));
    assert_eq!(
        after(14),
        (0, Some(StatusEffect::Poison), UnitState::Fainted)
    );
    assert_eq!(
        after(15),
        (
            0,
            Some(StatusEffect::Sleep { turns_remaining: 1 }),
            UnitState::Fainted
        )
    );
}

/// BT2.7: a KO sweep that ends the battle stops the upkeep there — `BattleEnd` is the last
/// event, no StatusCured, no thaw roll, the round unchanged.
/// Kills: expiry/caps/next-round run after the battle ended.
#[test]
fn a_sweep_that_ends_the_battle_skips_expiry_caps_and_the_next_round_bt2_7() {
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            sick(
                body(1, Side::A, 0, 100, 100, 50),
                StatusEffect::Sleep { turns_remaining: 1 },
            ),
            sick(body(3, Side::A, 1, 100, 100, 30), StatusEffect::Freeze),
            sick(body(2, Side::B, 0, 40, 5, 40), StatusEffect::Poison),
        ],
    );
    st.round = 3;
    let seq = st.action_seq;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::StatusTick {
                unit: 2,
                status: StatusEffect::Poison,
                amount: 5
            },
            TacticalEvent::Ko { unit: 2 },
            TacticalEvent::BattleEnd {
                outcome: BattleOutcome::SideAWins,
                how: BattleEndHow::SideEmpty
            },
        ]
    );
    assert_eq!(st.round, 3);
    assert_eq!(st.outcome, BattleOutcome::SideAWins);
    assert_eq!(st.action_seq, seq, "no thaw roll");
    assert_eq!(
        unit_of(&st, 1).status,
        Some(StatusEffect::Sleep { turns_remaining: 1 })
    );
    assert_eq!(unit_of(&st, 3).status, Some(StatusEffect::Freeze));
}

/// BT2.7: upkeep on a finished battle emits nothing and changes nothing.
/// Kills: ticks or Surge applied after the battle ended.
#[test]
fn upkeep_on_a_finished_battle_does_nothing_bt2_7() {
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            sick(body(1, Side::A, 0, 100, 100, 50), StatusEffect::Poison),
            sick(body(2, Side::B, 0, 100, 3, 40), StatusEffect::Freeze),
        ],
    );
    st.round = 12;
    st.outcome = BattleOutcome::SideBWins;
    let before = st.clone();
    assert!(run_upkeep(&mut st, &design()).is_empty());
    assert_eq!(st, before);
}

/// BT2.7: the battle-end check also runs after every resolved entry — an attack whose KO
/// empties a side emits `BattleEnd { winner, SideEmpty }` itself and decides the outcome, for
/// either side.
/// Kills: battle end checked only in upkeep (the loser would keep acting until round end).
#[test]
fn an_attack_that_empties_a_side_ends_the_battle_itself_bt2_7() {
    let cases = [
        (1u32, c(3, 3), 2u32, BattleOutcome::SideAWins),
        (2, c(2, 3), 1, BattleOutcome::SideBWins),
    ];
    for (attacker, aim, target, winner) in cases {
        let mut st = state(
            BattleKind::Pvp,
            9,
            vec![
                unit(
                    1,
                    Side::A,
                    0,
                    c(2, 3),
                    water(5, LETHAL_DEF, 50, vec![light(10, Affinity::Fire, melee())]),
                    5,
                ),
                unit(
                    2,
                    Side::B,
                    0,
                    c(3, 3),
                    water(5, LETHAL_DEF, 40, vec![light(10, Affinity::Fire, melee())]),
                    5,
                ),
            ],
        );
        st.unit_mut(target).expect("the target").first_stand = false;
        turn_start(&mut st, attacker, &design()).expect("the attacker starts");
        let out = resolve_attack(&mut st, attacker, 10, aim, &chart(), &design())
            .expect("a valid attack");
        assert_eq!(
            out.events[1..],
            [
                TacticalEvent::Ko { unit: target },
                TacticalEvent::BattleEnd {
                    outcome: winner,
                    how: BattleEndHow::SideEmpty
                },
            ]
        );
        assert_eq!(st.outcome, winner);
        assert_eq!(can_act(&st, attacker), Err(ActError::BattleOver));
    }
}

/// BT2.7 (plan A10, the carried `tick_status`): Sleep counts down — 2 → 1 stays asleep, 1 and 0
/// are cured (0 is never a trap) — with no roll drawn.
/// Kills: Sleep 0 never cured; Sleep cured one turn early; a roll drawn for Sleep.
#[test]
fn sleep_counts_down_and_cures_at_one_or_zero_turns_left_bt2_7() {
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            sick(
                body(1, Side::A, 0, 100, 100, 90),
                StatusEffect::Sleep { turns_remaining: 2 },
            ),
            sick(
                body(2, Side::A, 1, 100, 100, 80),
                StatusEffect::Sleep { turns_remaining: 1 },
            ),
            sick(
                body(3, Side::A, 2, 100, 100, 70),
                StatusEffect::Sleep { turns_remaining: 0 },
            ),
            body(4, Side::B, 0, 100, 100, 60),
        ],
    );
    let seq = st.action_seq;
    let events = run_upkeep(&mut st, &design());
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(matches!(
        events[0],
        TacticalEvent::StatusCured {
            unit: 2,
            status: StatusEffect::Sleep { .. }
        }
    ));
    assert!(matches!(
        events[1],
        TacticalEvent::StatusCured {
            unit: 3,
            status: StatusEffect::Sleep { .. }
        }
    ));
    assert_eq!(
        unit_of(&st, 1).status,
        Some(StatusEffect::Sleep { turns_remaining: 1 })
    );
    assert_eq!(unit_of(&st, 2).status, None);
    assert_eq!(unit_of(&st, 3).status, None);
    assert_eq!(st.action_seq, seq);
}

/// BT2.7 (plan A10): Freeze thaws on a roll of 80 but not 79 — one draw from the private stream
/// at `action_seq` — on seeds chosen so the roll is exactly that.
/// Kills: `>` for `>=`; a thaw threshold other than 80; no draw.
#[test]
fn freeze_thaws_on_a_roll_of_eighty_but_not_seventy_nine_bt2_7() {
    for (roll, thaws) in [(79u64, false), (80, true)] {
        let seed = (0u64..)
            .find(|&s| mix(s ^ 7) % 100 == roll)
            .expect("a seed for that roll");
        let mut st = state(
            BattleKind::Pvp,
            seed,
            vec![
                sick(body(1, Side::A, 0, 100, 100, 50), StatusEffect::Freeze),
                body(2, Side::B, 0, 100, 100, 40),
            ],
        );
        st.action_seq = 7;
        let events = run_upkeep(&mut st, &design());
        let want = if thaws {
            vec![TacticalEvent::StatusCured {
                unit: 1,
                status: StatusEffect::Freeze,
            }]
        } else {
            vec![]
        };
        assert_eq!(events, want, "roll {roll}");
        assert_eq!(
            unit_of(&st, 1).status,
            (!thaws).then_some(StatusEffect::Freeze),
            "roll {roll}"
        );
        assert_eq!(st.action_seq, 8);
    }
}

/// BT2.7: Poison, Burn and Paralysis persist through expiry (only Sleep and Freeze expire) and
/// draw nothing.
/// Kills: every status expiring after a round; a roll drawn for a non-Freeze status.
#[test]
fn poison_burn_and_paralysis_persist_through_expiry_bt2_7() {
    let mut st = state(
        BattleKind::Pvp,
        4,
        vec![
            sick(body(1, Side::A, 0, 800, 800, 90), StatusEffect::Poison),
            sick(body(2, Side::A, 1, 800, 800, 80), StatusEffect::Burn),
            sick(body(3, Side::A, 2, 800, 800, 70), StatusEffect::Paralysis),
            body(4, Side::B, 0, 100, 100, 60),
        ],
    );
    let seq = st.action_seq;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::StatusTick {
                unit: 1,
                status: StatusEffect::Poison,
                amount: 100
            },
            TacticalEvent::StatusTick {
                unit: 2,
                status: StatusEffect::Burn,
                amount: 50
            },
        ]
    );
    assert_eq!(unit_of(&st, 1).status, Some(StatusEffect::Poison));
    assert_eq!(unit_of(&st, 2).status, Some(StatusEffect::Burn));
    assert_eq!(unit_of(&st, 3).status, Some(StatusEffect::Paralysis));
    assert_eq!(st.action_seq, seq);
}

/// BT2.7 (judgement 6): each frozen unit draws ONE thaw roll, in initiative order — the seed
/// makes the roll at seq 3 thaw and the roll at seq 4 not, so the faster frozen unit (2) thaws
/// and the slower (1) stays frozen; a sleeper draws nothing (2 draws in all).
/// Kills: thaw rolls in units/id order; one roll shared by every frozen unit; a draw for Sleep.
#[test]
fn each_frozen_unit_draws_one_thaw_roll_in_initiative_order_bt2_7() {
    let seed = (0u64..)
        .find(|&s| mix(s ^ 3) % 100 >= 80 && mix(s ^ 4) % 100 < 80)
        .expect("a seed that thaws the first frozen unit only");
    let mut st = state(
        BattleKind::Pvp,
        seed,
        vec![
            sick(body(1, Side::A, 0, 100, 100, 40), StatusEffect::Freeze),
            sick(body(2, Side::A, 1, 100, 100, 90), StatusEffect::Freeze),
            sick(
                body(3, Side::B, 0, 100, 100, 60),
                StatusEffect::Sleep { turns_remaining: 2 },
            ),
            body(4, Side::B, 1, 100, 100, 20),
        ],
    );
    assert_eq!(st.initiative, vec![2, 3, 1, 4]);
    st.action_seq = 3;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![TacticalEvent::StatusCured {
            unit: 2,
            status: StatusEffect::Freeze
        }]
    );
    assert_eq!(st.action_seq, 5);
    assert_eq!(unit_of(&st, 2).status, None);
    assert_eq!(unit_of(&st, 1).status, Some(StatusEffect::Freeze));
    assert_eq!(
        unit_of(&st, 3).status,
        Some(StatusEffect::Sleep { turns_remaining: 1 })
    );
}

/// BT2.7 (plan A10): `status_tick_damage` equals the `StatusDamage.amount` the carried public
/// `apply_post_turn_effects` deals for every max_hp in 1..=65 535 — Poison and Burn — and both
/// tick nothing for Paralysis, Sleep and Freeze.
/// Kills: a re-stated DoT that drifts from M14 (wrong divisor, no min 1, a ceiling).
#[test]
fn status_tick_damage_is_the_carried_dot_for_every_max_hp_bt2_7() {
    let monster = |max_hp: u16| BattleMonster {
        species_id: 1,
        affinity: Affinity::Water,
        level: 50,
        current_hp: max_hp,
        max_hp,
        stats: stat_block(max_hp, 50, 50, 50),
        known_skill_ids: vec![],
        status: None,
    };
    let mut battle = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![monster(1)],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![monster(100)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };
    let statuses = [
        StatusEffect::Poison,
        StatusEffect::Burn,
        StatusEffect::Paralysis,
        StatusEffect::Sleep { turns_remaining: 2 },
        StatusEffect::Freeze,
    ];
    for status in statuses {
        let store = BattleStatusStore {
            side_a: vec![Some(status)],
            side_b: vec![None],
        };
        for max_hp in 1..=u16::MAX {
            {
                let m = battle.side_a.active_monster_mut();
                m.max_hp = max_hp;
                m.current_hp = max_hp;
            }
            battle.outcome = BattleOutcome::Ongoing;
            let carried = apply_post_turn_effects(&mut battle, &store)
                .into_iter()
                .find_map(|e| match e {
                    BattleEvent::StatusDamage {
                        side: SideId::SideA,
                        amount,
                    } => Some(amount),
                    _ => None,
                });
            assert_eq!(
                status_tick_damage(&status, max_hp),
                carried,
                "{status:?} at max_hp {max_hp}"
            );
        }
    }
}

/// BT2.7 (plan A12): a wild battle auto-flees at the round cap — round 29's upkeep advances to
/// 30; round 30's ends `Fled` by `RoundCap` and stays at 30; past the cap (31) also flees; the
/// cap is read from the tuning; PvP has no cap.
/// Kills: `round > cap`; a hard-coded 30; a cap applied to PvP.
#[test]
fn a_wild_battle_auto_flees_at_the_round_cap_bt2_7() {
    let wild = || {
        state(
            BattleKind::Wild,
            1,
            vec![
                body(1, Side::A, 0, 100, 100, 50),
                body(2, Side::B, 0, 100, 100, 40),
            ],
        )
    };
    let fled = vec![TacticalEvent::BattleEnd {
        outcome: BattleOutcome::Fled,
        how: BattleEndHow::RoundCap,
    }];
    let mut st = wild();
    st.round = 29;
    assert!(run_upkeep(&mut st, &design()).is_empty());
    assert_eq!((st.round, st.outcome), (30, BattleOutcome::Ongoing));
    assert_eq!(run_upkeep(&mut st, &design()), fled);
    assert_eq!((st.round, st.outcome), (30, BattleOutcome::Fled));

    let mut late = wild();
    late.round = 31;
    assert_eq!(run_upkeep(&mut late, &design()), fled);

    let mut early = wild();
    early.round = 5;
    assert_eq!(
        run_upkeep(&mut early, &perturb(|t| t.wild_round_cap = 5)),
        fled
    );

    let mut pvp = duel(BattleKind::Pvp, 1);
    pvp.round = 30;
    assert!(run_upkeep(&mut pvp, &perturb(|t| t.surge_start_round = 1_000)).is_empty());
    assert_eq!((pvp.round, pvp.outcome), (31, BattleOutcome::Ongoing));
}

// ===========================================================================
// BT2.8 — Surge
// ===========================================================================

/// BT2.8: Surge at the design tuning — nothing before round 9; then max_hp × 5 × (r − 8) / 100,
/// floor, min 1 (100 HP: 5 at r 9, 10 at r 10, 30 at r 14; every max_hp up to 19 takes 1 at
/// r 9; 19 HP takes 1, 1, 2, 3, 4, 5, 6 over rounds 9..=15).
/// Kills: a Surge one round early or late; no min 1; a ceiling; `r − 9` for `r − 8`.
#[test]
fn surge_deals_five_percent_a_round_from_round_nine_bt2_8() {
    let tu = design();
    assert_eq!(surge_damage(100, 0, &tu), None);
    assert_eq!(surge_damage(100, 8, &tu), None);
    assert_eq!(surge_damage(100, 9, &tu), Some(5));
    assert_eq!(surge_damage(100, 10, &tu), Some(10));
    assert_eq!(surge_damage(100, 14, &tu), Some(30));
    for max_hp in 1..=19u16 {
        assert_eq!(surge_damage(max_hp, 9, &tu), Some(1), "max_hp {max_hp}");
    }
    assert_eq!(surge_damage(20, 9, &tu), Some(1));
    assert_eq!(surge_damage(40, 9, &tu), Some(2));
    for (round, want) in [
        (9u16, 1u16),
        (10, 1),
        (11, 2),
        (12, 3),
        (13, 4),
        (14, 5),
        (15, 6),
    ] {
        assert_eq!(surge_damage(19, round, &tu), Some(want), "round {round}");
    }
}

/// BT2.8: the start round and the per-round percentage are read from the tuning, each alone.
/// Kills: a hard-coded 9 or 5.
#[test]
fn surge_reads_its_start_round_and_rate_from_the_tuning_bt2_8() {
    let early = perturb(|t| t.surge_start_round = 5);
    assert_eq!(surge_damage(100, 4, &early), None);
    assert_eq!(surge_damage(100, 5, &early), Some(5));
    assert_eq!(surge_damage(100, 9, &early), Some(25));
    let fierce = perturb(|t| t.surge_pct_per_round = 10);
    assert_eq!(surge_damage(100, 8, &fierce), None);
    assert_eq!(surge_damage(100, 9, &fierce), Some(10));
    assert_eq!(surge_damage(100, 14, &fierce), Some(60));
}

/// BT2.8 (plan A1): u64 intermediates saturating to `u16::MAX` — 65 535 HP at round 30 is
/// 72 088 → 65 535 (a wrapping cast would give 6 552) and at round 65 535 is far past u32; the
/// `round + 1 − start` term cannot overflow u16 (start 0, round 65 535).
/// Kills: u16 or u32 intermediates; a wrapping cast; `round + 1` in u16.
#[test]
fn surge_arithmetic_saturates_instead_of_overflowing_bt2_8() {
    let tu = design();
    assert_eq!(surge_damage(u16::MAX, 14, &tu), Some(19_660));
    assert_eq!(surge_damage(u16::MAX, 30, &tu), Some(u16::MAX));
    assert_eq!(surge_damage(u16::MAX, u16::MAX, &tu), Some(u16::MAX));
    let from_zero = perturb(|t| t.surge_start_round = 0);
    assert_eq!(surge_damage(100, 0, &from_zero), Some(5));
    let maxed = perturb(|t| {
        t.surge_start_round = 0;
        t.surge_pct_per_round = u8::MAX;
    });
    assert_eq!(surge_damage(u16::MAX, u16::MAX, &maxed), Some(u16::MAX));
}

/// BT2.8: a wild battle never Surges — from round 9 to the round-30 cap no Surge event and no
/// HP lost; the only event is the cap's auto-flee.
/// Kills: Surge keyed on the round alone.
#[test]
fn a_wild_battle_never_surges_bt2_8() {
    let mut st = state(
        BattleKind::Wild,
        1,
        vec![
            body(1, Side::A, 0, 100, 100, 50),
            body(2, Side::B, 0, 100, 100, 40),
        ],
    );
    st.round = 9;
    let mut events = Vec::new();
    for _ in 9..=30 {
        events.extend(run_upkeep(&mut st, &design()));
    }
    assert_eq!(
        events,
        vec![TacticalEvent::BattleEnd {
            outcome: BattleOutcome::Fled,
            how: BattleEndHow::RoundCap
        }]
    );
    assert_eq!((unit_of(&st, 1).cur_hp, unit_of(&st, 2).cur_hp), (100, 100));
}

/// BT2.8: Practice surges exactly like PvP (the PvP ruleset), in initiative order.
/// Kills: Practice treated as wild.
#[test]
fn a_practice_battle_surges_like_pvp_bt2_8() {
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        let mut st = state(
            kind,
            1,
            vec![
                body(1, Side::A, 0, 100, 100, 50),
                body(2, Side::B, 0, 200, 200, 40),
            ],
        );
        st.round = 9;
        assert_eq!(
            run_upkeep(&mut st, &design()),
            vec![
                TacticalEvent::Surge {
                    round: 9,
                    unit: 1,
                    amount: 5
                },
                TacticalEvent::Surge {
                    round: 9,
                    unit: 2,
                    amount: 10
                },
            ],
            "{kind:?}"
        );
        assert_eq!((unit_of(&st, 1).cur_hp, unit_of(&st, 2).cur_hp), (95, 190));
    }
}

/// BT2.8: Surge is a share of MAX HP whatever HP is left (100 max at 50 → 10; 200 max at 150 →
/// 20, at round 10).
/// Kills: Surge computed from current HP.
#[test]
fn surge_is_a_share_of_max_hp_whatever_is_left_bt2_8() {
    let mut st = state(
        BattleKind::Pvp,
        5,
        vec![
            body(1, Side::A, 0, 100, 50, 50),
            body(2, Side::B, 0, 200, 150, 40),
        ],
    );
    st.round = 10;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::Surge {
                round: 10,
                unit: 1,
                amount: 10
            },
            TacticalEvent::Surge {
                round: 10,
                unit: 2,
                amount: 20
            },
        ]
    );
    assert_eq!((unit_of(&st, 1).cur_hp, unit_of(&st, 2).cur_hp), (40, 130));
}

/// BT2.8: Surge is true damage — the full amount through Guard (no ×3/4) and through
/// First-Stand (to 0, then the sweep KOs it).
/// Kills: Surge routed through the attack pipeline (Guard → 7, First-Stand → 1 HP left).
#[test]
fn surge_is_true_damage_past_guard_and_first_stand_bt2_8() {
    let mut st = state(
        BattleKind::Pvp,
        5,
        vec![
            body(1, Side::A, 0, 100, 10, 90),
            body(3, Side::A, 1, 100, 100, 80),
            body(2, Side::B, 0, 100, 100, 70),
        ],
    );
    st.unit_mut(1).expect("unit 1").guard = true;
    assert!(unit_of(&st, 1).first_stand);
    st.round = 10;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::Surge {
                round: 10,
                unit: 1,
                amount: 10
            },
            TacticalEvent::Surge {
                round: 10,
                unit: 3,
                amount: 10
            },
            TacticalEvent::Surge {
                round: 10,
                unit: 2,
                amount: 10
            },
            TacticalEvent::Ko { unit: 1 },
        ]
    );
    let hit = unit_of(&st, 1);
    assert_eq!((hit.cur_hp, hit.state), (0, UnitState::Fainted));
}

/// BT2.8 (plan A1, the true bound): for EVERY max_hp in 1..=65 535, Surge alone over rounds
/// 9..=15 removes at least max_hp — so every PvP match terminates by the end of round 15.
/// Kills: a Surge formula weaker than specified anywhere in the u16 range.
#[test]
fn surge_alone_removes_every_max_hp_by_the_end_of_round_fifteen_bt2_8() {
    let tu = design();
    for max_hp in 1..=u16::MAX {
        let total: u32 = (9..=15u16)
            .map(|r| u32::from(surge_damage(max_hp, r, &tu).expect("Surge from round 9")))
            .sum();
        assert!(total >= u32::from(max_hp), "max_hp {max_hp}: {total}");
    }
}

/// BT2.8 (plan A1, the documented erratum): the spec's "by round 14" misses by the flooring —
/// Σ over rounds 9..=14 is 16 for max_hp 19, 36 for 39 and 78 for 79 (each below max_hp),
/// while 20 gets 21 and 100 gets 105.
/// Kills: a silently "fixed" (ceiling) formula that diverges from the specified floor.
#[test]
fn the_round_fourteen_bound_misses_by_the_flooring_bt2_8() {
    let tu = design();
    let through_14 = |max_hp: u16| -> u32 {
        (9..=14u16)
            .map(|r| u32::from(surge_damage(max_hp, r, &tu).expect("Surge from round 9")))
            .sum()
    };
    assert_eq!(through_14(19), 16);
    assert_eq!(through_14(39), 36);
    assert_eq!(through_14(79), 78);
    assert_eq!(through_14(20), 21);
    assert_eq!(through_14(100), 105);
}

/// One side of a random PvP battle: `(max_hp, raw)` per unit, `cur_hp = 1 + raw % max_hp`.
fn arb_side() -> impl Strategy<Value = Vec<(u16, u16)>> {
    prop::collection::vec((1u16..=u16::MAX, any::<u16>()), 1..=3)
}

fn side_units(side: Side, first_id: u32, raw: &[(u16, u16)]) -> Vec<TacticalUnit> {
    raw.iter()
        .zip(0u8..)
        .map(|(&(max_hp, roll), slot)| {
            body(
                first_id + u32::from(slot),
                side,
                slot,
                max_hp,
                1 + roll % max_hp,
                50,
            )
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// BT2.8 (plan A1): any PvP battle (1–3 units a side, any max_hp ≥ 1, any HP ≤ max) left to
    /// upkeep alone from round 1 is decided — SideAWins or SideBWins, never Ongoing or Fled — by
    /// the end of round 15.
    /// Kills: Surge missing or too weak; a double wipe left undecided.
    #[test]
    fn every_pvp_battle_is_decided_by_the_end_of_round_fifteen_bt2_8(
        a in arb_side(),
        b in arb_side(),
        seed in any::<u64>(),
    ) {
        let mut units = side_units(Side::A, 1, &a);
        units.extend(side_units(Side::B, 10, &b));
        let mut st = state(BattleKind::Pvp, seed, units);
        let tu = design();
        for _ in 1..=15 {
            let _ = run_upkeep(&mut st, &tu);
        }
        prop_assert!(
            matches!(st.outcome, BattleOutcome::SideAWins | BattleOutcome::SideBWins),
            "{:?} at round {}",
            st.outcome,
            st.round
        );
    }
}

/// BT2.8 (plan A1, the erratum as a battle): a 19-HP mirror is still Ongoing after round 14's
/// upkeep (16 Surge so far, 3 HP each), and round 15's Surge (6) wipes both — tied on HP percent,
/// conscious units and damage dealt, so the coin `splitmix64(seed ^ 15) & 1` decides.
/// Kills: a termination claim that hides the erratum; a double wipe outside adjudication.
#[test]
fn a_nineteen_hp_mirror_survives_round_fourteen_and_ends_in_round_fifteen_bt2_8() {
    let seed = 3u64;
    let mut st = state(
        BattleKind::Pvp,
        seed,
        vec![
            body(1, Side::A, 0, 19, 19, 50),
            body(2, Side::B, 0, 19, 19, 40),
        ],
    );
    let tu = design();
    for _ in 1..=14 {
        let _ = run_upkeep(&mut st, &tu);
    }
    assert_eq!((st.round, st.outcome), (15, BattleOutcome::Ongoing));
    assert_eq!((unit_of(&st, 1).cur_hp, unit_of(&st, 2).cur_hp), (3, 3));
    let events = run_upkeep(&mut st, &tu);
    let winner = if (mix(seed ^ 15) & 1) == 0 {
        BattleOutcome::SideAWins
    } else {
        BattleOutcome::SideBWins
    };
    assert_eq!(
        events.last(),
        Some(&TacticalEvent::BattleEnd {
            outcome: winner,
            how: BattleEndHow::Adjudicated(Adjudication::Coin)
        })
    );
    assert_eq!(st.outcome, winner);
}

// ===========================================================================
// BT2.3 / BT2.6 — Guard and First-Stand do not touch ticks or Surge
// ===========================================================================

/// BT2.3: Guard holds through the round's upkeep and ends only at the unit's next TurnStart.
/// Kills: Guard cleared at round end.
#[test]
fn guard_holds_through_upkeep_until_the_units_next_turn_start_bt2_3() {
    let mut st = duel(BattleKind::Pvp, 3);
    ready(&mut st, 1);
    assert_eq!(
        turn_end(&mut st, 1, TurnEndCause::EndTurn, &design()),
        Ok(true)
    );
    assert!(run_upkeep(&mut st, &design()).is_empty());
    assert_eq!(st.round, 2);
    assert!(unit_of(&st, 1).guard);
    ready(&mut st, 1);
    assert!(!unit_of(&st, 1).guard);
}

/// BT2.3: Guard does not reduce status ticks or Surge — a Guarded and an unguarded twin take the
/// same tick (20) and the same Surge (8) and end on the same HP.
/// Kills: ticks or Surge routed through `apply_guard`.
#[test]
fn guard_does_not_soften_status_ticks_or_surge_bt2_3() {
    let mut st = state(
        BattleKind::Pvp,
        6,
        vec![
            sick(body(1, Side::A, 0, 160, 160, 90), StatusEffect::Poison),
            sick(body(2, Side::A, 1, 160, 160, 80), StatusEffect::Poison),
            body(3, Side::B, 0, 100, 100, 70),
        ],
    );
    st.unit_mut(1).expect("unit 1").guard = true;
    st.round = 9;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::StatusTick {
                unit: 1,
                status: StatusEffect::Poison,
                amount: 20
            },
            TacticalEvent::StatusTick {
                unit: 2,
                status: StatusEffect::Poison,
                amount: 20
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 1,
                amount: 8
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 2,
                amount: 8
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 3,
                amount: 5
            },
        ]
    );
    assert_eq!((unit_of(&st, 1).cur_hp, unit_of(&st, 2).cur_hp), (132, 132));
    assert!(unit_of(&st, 1).guard);
}

/// BT2.6: a status tick ignores First-Stand — it takes a never-activated unit to 0 (Poison 5 of
/// 5 HP; Burn 1 of 1 HP) and the sweep KOs it.
/// Kills: First-Stand applied to status damage (the unit left at 1 HP).
#[test]
fn a_status_tick_takes_a_first_stand_unit_to_zero_bt2_6() {
    for (status, max_hp, cur_hp, amount) in [
        (StatusEffect::Poison, 40u16, 5u16, 5u16),
        (StatusEffect::Burn, 16, 1, 1),
    ] {
        let mut st = state(
            BattleKind::Pvp,
            2,
            vec![
                sick(body(1, Side::A, 0, max_hp, cur_hp, 90), status),
                body(3, Side::A, 1, 100, 100, 80),
                body(2, Side::B, 0, 100, 100, 70),
            ],
        );
        assert!(unit_of(&st, 1).first_stand);
        assert_eq!(
            run_upkeep(&mut st, &design()),
            vec![
                TacticalEvent::StatusTick {
                    unit: 1,
                    status,
                    amount
                },
                TacticalEvent::Ko { unit: 1 },
            ],
            "{status:?}"
        );
        assert_eq!(unit_of(&st, 1).cur_hp, 0);
    }
}

/// BT2.6: Surge ignores First-Stand — a never-activated unit at 5 HP takes the full round-9
/// Surge (5 of 100 max) to 0 and the sweep KOs it.
/// Kills: First-Stand applied to Surge.
#[test]
fn surge_takes_a_first_stand_unit_to_zero_bt2_6() {
    let mut st = state(
        BattleKind::Pvp,
        2,
        vec![
            body(1, Side::A, 0, 100, 5, 90),
            body(3, Side::A, 1, 100, 100, 80),
            body(2, Side::B, 0, 100, 100, 70),
        ],
    );
    assert!(unit_of(&st, 1).first_stand);
    st.round = 9;
    assert_eq!(
        run_upkeep(&mut st, &design()),
        vec![
            TacticalEvent::Surge {
                round: 9,
                unit: 1,
                amount: 5
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 3,
                amount: 5
            },
            TacticalEvent::Surge {
                round: 9,
                unit: 2,
                amount: 5
            },
            TacticalEvent::Ko { unit: 1 },
        ]
    );
    assert_eq!(unit_of(&st, 1).cur_hp, 0);
}
