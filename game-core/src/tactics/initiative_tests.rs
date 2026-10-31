//! bt-2 gating tests — `tactics::initiative` (BT2.4): the round comparator `(eff_speed desc,
//! base_speed desc, tie_rank asc, slot asc)`, the alternating tie priority, the round-1 coin,
//! and the frozen-per-round list on `TacticalState` (built at `new`, edited only by removals,
//! rebuilt by upkeep).
//!
//! Hand vectors assign ids in the REVERSE of the expected order so an id-sort cannot pass. The
//! coin oracle is `crate::tick_seed(x, 0, 0) & 1` (canonical splitmix64), independent of
//! `resolve::splitmix64`; seeds are searched for so that the salted coin disagrees with the
//! bare-seed, round-xored and salt-added coins. Test names end in the criterion tag `_bt2_4`.

use std::cmp::{Ordering, Reverse};

use proptest::prelude::*;

use crate::monster::types::Affinity;

use super::geometry::Side;
use super::initiative::{compare, order, priority_for_round, round1_priority, Contender, TIE_SALT};
use super::movement::MoveClass;
use super::resolve::TacticalState;
use super::resolve_tests::{c, coin, design, kit, stat_block, state, unit, water, CHIP_DEF};
use super::tuning::BattleKind;
use super::upkeep::run_upkeep;

fn ct(id: u32, side: Side, slot: u8, eff_speed: u16, base_speed: u16) -> Contender {
    Contender {
        id,
        side,
        slot,
        eff_speed,
        base_speed,
    }
}

fn other(side: Side) -> Side {
    match side {
        Side::A => Side::B,
        Side::B => Side::A,
    }
}

/// The independent sort key: eff desc, base desc, tie_rank asc (0 = the priority side), slot
/// asc, id asc.
fn key(x: &Contender, priority: Side) -> (Reverse<u16>, Reverse<u16>, u8, u8, u32) {
    (
        Reverse(x.eff_speed),
        Reverse(x.base_speed),
        u8::from(x.side != priority),
        x.slot,
        x.id,
    )
}

fn arb_contender() -> impl Strategy<Value = Contender> {
    (0u32..6, any::<bool>(), 0u8..3, 0u16..3, 0u16..3).prop_map(|(id, on_a, slot, eff, base)| {
        ct(id, if on_a { Side::A } else { Side::B }, slot, eff, base)
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// BT2.4: on contenders with distinct (side, slot), `compare` agrees exactly with the
    /// independent key and is a strict total order — antisymmetric, Equal only on itself,
    /// trichotomous (never Equal across distinct side/slot), transitive — and `order` returns
    /// the ids sorted by it. Speeds are drawn from 0..3 so ties are common.
    /// Kills: any key level dropped, inverted or reordered; a partial order on ties.
    #[test]
    fn compare_is_a_strict_total_order_on_distinct_side_slots_bt2_4(
        a in arb_contender(),
        b in arb_contender(),
        e in arb_contender(),
        priority_a in any::<bool>(),
    ) {
        prop_assume!((a.side, a.slot) != (b.side, b.slot));
        prop_assume!((a.side, a.slot) != (e.side, e.slot));
        prop_assume!((b.side, b.slot) != (e.side, e.slot));
        let p = if priority_a { Side::A } else { Side::B };
        for (x, y) in [(&a, &b), (&b, &e), (&a, &e)] {
            prop_assert_eq!(compare(x, y, p), key(x, p).cmp(&key(y, p)));
            prop_assert_eq!(compare(x, y, p), compare(y, x, p).reverse());
            prop_assert_ne!(compare(x, y, p), Ordering::Equal);
        }
        prop_assert_eq!(compare(&a, &a, p), Ordering::Equal);
        if compare(&a, &b, p) == Ordering::Less && compare(&b, &e, p) == Ordering::Less {
            prop_assert_eq!(compare(&a, &e, p), Ordering::Less);
        }
        let mut sorted = [a, b, e];
        sorted.sort_by_key(|x| key(x, p));
        let want: Vec<u32> = sorted.iter().map(|x| x.id).collect();
        prop_assert_eq!(order(&[a, b, e], p), want);
    }
}

/// BT2.4: eff_speed decides first — over base speed (ascending against it), the priority side
/// and slot.
/// Kills: base speed or slot sorted ahead of eff_speed; ascending eff_speed.
#[test]
fn eff_speed_orders_first_bt2_4() {
    let cs = [
        ct(1, Side::A, 0, 10, 90),
        ct(2, Side::A, 1, 20, 80),
        ct(3, Side::B, 2, 30, 70),
    ];
    assert_eq!(order(&cs, Side::A), vec![3, 2, 1]);
    assert_eq!(order(&cs, Side::B), vec![3, 2, 1]);
}

/// BT2.4: base_speed decides when eff_speed ties.
/// Kills: base speed ignored (ties fall through to side/slot); ascending base speed.
#[test]
fn base_speed_breaks_an_eff_speed_tie_bt2_4() {
    let cs = [
        ct(1, Side::A, 0, 50, 10),
        ct(2, Side::A, 1, 50, 20),
        ct(3, Side::B, 2, 50, 30),
    ];
    assert_eq!(order(&cs, Side::A), vec![3, 2, 1]);
    assert_eq!(compare(&cs[2], &cs[0], Side::A), Ordering::Less);
}

/// BT2.4: with both speeds equal the side holding tie priority goes first, for either priority
/// — even when it holds the higher slot.
/// Kills: tie_rank ignored (slot decides); tie_rank inverted; priority fixed to A.
#[test]
fn equal_speeds_put_the_priority_side_first_bt2_4() {
    let cs = [ct(1, Side::A, 0, 50, 50), ct(2, Side::B, 1, 50, 50)];
    assert_eq!(order(&cs, Side::B), vec![2, 1]);
    assert_eq!(order(&cs, Side::A), vec![1, 2]);
    assert_eq!(compare(&cs[0], &cs[1], Side::B), Ordering::Greater);
    assert_eq!(compare(&cs[0], &cs[1], Side::A), Ordering::Less);
}

/// BT2.4: inside one side, with everything else equal, slot ascending decides.
/// Kills: slot descending; id order in place of slot.
#[test]
fn slot_orders_units_of_one_side_last_bt2_4() {
    let cs = [
        ct(1, Side::A, 2, 50, 50),
        ct(2, Side::A, 1, 50, 50),
        ct(3, Side::A, 0, 50, 50),
    ];
    assert_eq!(order(&cs, Side::A), vec![3, 2, 1]);
    assert_eq!(order(&cs, Side::B), vec![3, 2, 1]);
}

/// BT2.4: every key level at once — 13 is fastest, 14 wins the eff tie on base speed, then the
/// priority side by slot, then the other side.
/// Kills: any key level applied out of order.
#[test]
fn the_full_key_orders_a_mixed_round_bt2_4() {
    let cs = [
        ct(10, Side::A, 0, 60, 60),
        ct(11, Side::B, 0, 60, 60),
        ct(12, Side::B, 1, 60, 60),
        ct(13, Side::A, 1, 70, 40),
        ct(14, Side::A, 2, 60, 61),
    ];
    assert_eq!(order(&cs, Side::B), vec![13, 14, 11, 12, 10]);
    assert_eq!(order(&cs, Side::A), vec![13, 14, 10, 11, 12]);
    assert!(order(&[], Side::A).is_empty());
}

/// BT2.4: tie priority alternates every round — round 1 the round-1 side, round 2 the other,
/// and so on to round 65 535; round 0 counts as round 1.
/// Kills: no alternation; alternation off by one round; round 0 treated as even.
#[test]
fn tie_priority_alternates_every_round_bt2_4() {
    for round1 in [Side::A, Side::B] {
        let flip = other(round1);
        for (round, want) in [
            (0u16, round1),
            (1, round1),
            (2, flip),
            (3, round1),
            (4, flip),
            (65_534, flip),
            (65_535, round1),
        ] {
            assert_eq!(
                priority_for_round(round1, round),
                want,
                "round-1 {round1:?}, round {round}"
            );
        }
    }
}

/// BT2.4: a wild battle's round 1 goes to the player side A whatever the coin says — checked on
/// 0x5EED (salted to splitmix64(0), low bit 1) and 0x5EEB (salted to splitmix64(6), low bit 0).
/// Kills: the PvP coin applied to wild battles.
#[test]
fn a_wild_round_one_goes_to_the_player_side_whatever_the_coin_bt2_4() {
    assert_eq!(coin(0x5EED ^ TIE_SALT), Side::B);
    assert_eq!(coin(0x5EEB ^ TIE_SALT), Side::A);
    for seed in [0x5EED_u64, 0x5EEB, 0, u64::MAX] {
        assert_eq!(
            round1_priority(BattleKind::Wild, seed),
            Side::A,
            "seed {seed:#x}"
        );
    }
}

/// Seeds whose salted coin names `want` while the bare-seed, round-1-xored and salt-added coins
/// all name the other side.
fn discriminating_seeds(want: Side) -> Vec<u64> {
    (0u64..)
        .filter(|&s| {
            coin(s ^ TIE_SALT) == want
                && coin(s) != want
                && coin(s ^ 1) != want
                && coin(s.wrapping_add(TIE_SALT)) != want
        })
        .take(3)
        .collect()
}

/// BT2.4: Pvp AND Practice round-1 priority is `splitmix64(seed ^ 0x5EED) & 1` (0 → A, 1 → B),
/// on seeds where `seed`, `seed ^ round` and `seed + 0x5EED` would each give the other side;
/// hand vectors 0x5EED → B and 0x5EEB → A.
/// Kills: an unsalted coin; the round xored in place of the salt; the salt added; inverted bit;
/// Practice treated as wild.
#[test]
fn pvp_and_practice_round_one_follow_the_salted_coin_bt2_4() {
    for want in [Side::A, Side::B] {
        let seeds = discriminating_seeds(want);
        assert_eq!(seeds.len(), 3);
        for seed in seeds {
            assert_eq!(
                round1_priority(BattleKind::Pvp, seed),
                want,
                "pvp seed {seed}"
            );
            assert_eq!(
                round1_priority(BattleKind::Practice, seed),
                want,
                "practice seed {seed}"
            );
        }
    }
    assert_eq!(round1_priority(BattleKind::Pvp, 0x5EED), Side::B);
    assert_eq!(round1_priority(BattleKind::Practice, 0x5EEB), Side::A);
}

/// Four units: speeds 30 (A0 = 1), 90 (A1 = 2), 60 (B0 = 3), 90 (B1 = 4).
fn four(kind: BattleKind, seed: u64) -> TacticalState {
    state(
        kind,
        seed,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(0, 0),
                water(100, CHIP_DEF, 30, vec![]),
                100,
            ),
            unit(
                2,
                Side::A,
                1,
                c(0, 2),
                water(100, CHIP_DEF, 90, vec![]),
                100,
            ),
            unit(
                3,
                Side::B,
                0,
                c(6, 0),
                water(100, CHIP_DEF, 60, vec![]),
                100,
            ),
            unit(
                4,
                Side::B,
                1,
                c(6, 2),
                water(100, CHIP_DEF, 90, vec![]),
                100,
            ),
        ],
    )
}

/// BT2.4: `TacticalState::new` builds the round-1 list — round 1, wild tie priority A, so the
/// 90/90 tie goes A's 2 before B's 4 — with nothing drawn, queued or decided.
/// Kills: no initiative at `new`; the round-1 priority not applied; units-order or id-order.
#[test]
fn a_new_battle_builds_the_round_one_initiative_bt2_4() {
    let st = four(BattleKind::Wild, 1);
    assert_eq!(st.round, 1);
    assert_eq!(st.tie_priority(), Side::A);
    assert_eq!(st.initiative, vec![2, 4, 3, 1]);
    assert_eq!(st.action_seq, 0);
    assert!(st.queued.is_empty());
    let pvp = four(BattleKind::Pvp, 0x5EED);
    assert_eq!(pvp.tie_priority(), Side::B);
    assert_eq!(pvp.initiative, vec![4, 2, 3, 1]);
}

/// BT2.4: the comparator inputs are the conscious units, each with its LEVELLED speed as
/// eff_speed and its species base speed (a 0-HP unit is not a contender).
/// Kills: base speed used as eff_speed; a 0-HP unit sorted into the round.
#[test]
fn contenders_are_the_conscious_units_with_levelled_and_base_speed_bt2_4() {
    let mut st = state(
        BattleKind::Pvp,
        1,
        vec![
            unit(
                1,
                Side::A,
                0,
                c(0, 0),
                kit(
                    1,
                    Affinity::Water,
                    5,
                    stat_block(50, 10, CHIP_DEF, 70),
                    20,
                    MoveClass::Walk,
                    vec![],
                ),
                50,
            ),
            unit(2, Side::B, 0, c(6, 6), water(50, CHIP_DEF, 40, vec![]), 50),
            unit(3, Side::B, 1, c(6, 4), water(50, CHIP_DEF, 30, vec![]), 50),
        ],
    );
    st.unit_mut(3).expect("unit 3").cur_hp = 0;
    let mut got = st.contenders();
    got.sort_by_key(|x| x.id);
    assert_eq!(
        got,
        vec![ct(1, Side::A, 0, 70, 20), ct(2, Side::B, 0, 40, 40)]
    );
}

/// BT2.4: the list is frozen for the round — a mid-round speed change leaves `initiative` as it
/// was until `rebuild_initiative`, which then applies it.
/// Kills: an initiative recomputed on read or on every state edit.
#[test]
fn a_mid_round_speed_change_waits_for_the_rebuild_bt2_4() {
    let mut st = four(BattleKind::Wild, 1);
    st.unit_mut(1).expect("unit 1").kit.stats.speed = 200;
    assert_eq!(st.initiative, vec![2, 4, 3, 1]);
    st.rebuild_initiative();
    assert_eq!(st.initiative, vec![1, 2, 4, 3]);
}

/// BT2.4: the only mid-round edit is a removal — `remove_from_initiative` drops the id from the
/// order AND from `queued`, never reorders the rest (a subsequence of the round-start list),
/// and returns whether the id was in the order.
/// Kills: a removal that re-sorts; a removal that leaves the READY id queued; a constant return.
#[test]
fn removal_drops_the_id_from_the_order_and_the_queue_without_reordering_bt2_4() {
    let mut st = four(BattleKind::Wild, 1);
    st.queued = vec![3, 4, 1];
    assert!(st.remove_from_initiative(4));
    assert_eq!(st.initiative, vec![2, 3, 1]);
    assert_eq!(st.queued, vec![3, 1]);
    assert!(!st.remove_from_initiative(4));
    assert_eq!(st.initiative, vec![2, 3, 1]);
    assert_eq!(st.queued, vec![3, 1]);
    assert!(!st.remove_from_initiative(99));
    assert!(st.remove_from_initiative(2));
    assert_eq!(st.initiative, vec![3, 1]);
    assert_eq!(st.queued, vec![3, 1]);
}

/// BT2.4: the round's upkeep increments the round and THEN rebuilds, so an equal-speed
/// cross-side tie swaps order between round r and r + 1 (wild [1, 2] → [2, 1]; PvP/Practice
/// seed 0x5EED, coin B, [2, 1] → [1, 2]).
/// Kills: a rebuild before the round increment; no rebuild at all.
#[test]
fn an_equal_speed_cross_side_tie_swaps_order_at_the_next_round_bt2_4() {
    for (kind, round1) in [
        (BattleKind::Wild, vec![1u32, 2]),
        (BattleKind::Pvp, vec![2, 1]),
        (BattleKind::Practice, vec![2, 1]),
    ] {
        let mut st = state(
            kind,
            0x5EED,
            vec![
                unit(
                    1,
                    Side::A,
                    0,
                    c(0, 0),
                    water(100, CHIP_DEF, 50, vec![]),
                    100,
                ),
                unit(
                    2,
                    Side::B,
                    0,
                    c(6, 6),
                    water(100, CHIP_DEF, 50, vec![]),
                    100,
                ),
            ],
        );
        assert_eq!(st.initiative, round1, "{kind:?} round 1");
        let priority = st.tie_priority();
        assert!(run_upkeep(&mut st, &design()).is_empty(), "{kind:?}");
        assert_eq!(st.round, 2);
        assert_eq!(st.tie_priority(), other(priority));
        let swapped: Vec<u32> = round1.iter().rev().copied().collect();
        assert_eq!(st.initiative, swapped, "{kind:?} round 2");
    }
}
