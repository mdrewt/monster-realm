//! bt-5 gating tests for `tactics::rewards` (BT5.6 - BT5.7): the in-battle ledger written by
//! `on_unit_defeated` (design section 7) and paid once at battle end by `pay`.
//!
//! Every expected value is hand-derived from the plan contracts (the reviewer block R1-R11 is
//! binding: Practice pays nothing; PvP pays essence to the killer, both sides; a bad level zeroes
//! XP only; zero-value credits are not recorded; `Credit` carries its `victim`; the errors are
//! exactly UnknownUnit / NotDefeated / AlreadyCredited), then cross-checked against the carried
//! rules (`combat::xp::battle_xp_reward`, `currency::essence_battle_reward`,
//! `currency::battle_currency_reward`).
//!
//! # The XP arithmetic
//!
//! With the killer at level 10 and the victim at level 20 the carried reward is
//! `bst * 20 / (5 * 10) + 1 = floor(2 * bst / 5) + 1`, so bst 330 -> 133 (odd), bst 335 -> 135,
//! bst 29 -> 12, bst 1000 -> 401. The split is `others = total / 2 / n` each and
//! `killer = total - others * n` (n = the killer's conscious teammates), so the killer keeps the
//! remainder: 133 with n = 1 is 67 / 66; 135 with n = 3 is 69 / 22 / 22 / 22 (`67 % 3 != 0`).
//!
//! Essence is `max(1, bst / 30)` (330 -> 11, 335 -> 11, 29 -> 1, 1000 -> 33), typed by the VICTIM's
//! affinity; currency is `bst / 10` (330 -> 33, 29 -> 2, 1000 -> 100), wild battles only.
//!
//! # Fixtures
//!
//! A 7x7 board (`resolve_tests::state`); a unit's tile is `(id % 7, id / 7)` (unique for ids < 49).
//! Side A is the player (ids 1..=9), side B the wild (ids 11..=19). A "KO" is staged by hand
//! (`faint`): the hook is called after the sweep, so the victim is already `Fainted`.
//!
//! Test names end in the criterion tag `_bt5_<k>`.

use crate::combat::types::BattleOutcome;
use crate::combat::xp::battle_xp_reward;
use crate::currency::{battle_currency_reward, essence_battle_reward};
use crate::monster::types::{Affinity, Level};

use super::geometry::Side;
use super::movement::MoveClass;
use super::resolve::{TacticalState, TacticalUnit, UnitState};
use super::resolve_tests::{c, kit, stat_block, state, unit};
use super::rewards::{on_unit_defeated, pay, Award, Credit, Ledger, Payout, RewardError};
use super::tuning::BattleKind;

// ===========================================================================
// Fixtures
// ===========================================================================

/// `(id, side, slot, level, affinity)`.
type Spec = (u32, Side, u8, u8, Affinity);

fn rk(spec: Spec) -> TacticalUnit {
    let (id, side, slot, level, affinity) = spec;
    unit(
        id,
        side,
        slot,
        c(
            u8::try_from(id % 7).expect("small"),
            u8::try_from(id / 7).expect("small"),
        ),
        kit(
            1,
            affinity,
            level,
            stat_block(100, 10, 100, 40),
            40,
            MoveClass::Walk,
            vec![],
        ),
        100,
    )
}

fn world(kind: BattleKind, specs: &[Spec]) -> TacticalState {
    state(kind, 7, specs.iter().copied().map(rk).collect())
}

/// The unit fainted by the sweep (state Fainted, 0 HP).
fn faint(st: &mut TacticalState, id: u32) {
    let u = st.unit_mut(id).expect("the unit exists");
    u.cur_hp = 0;
    u.state = UnitState::Fainted;
}

/// A unit at 0 HP the sweep has NOT yet processed (still Active).
fn at_zero_hp(st: &mut TacticalState, id: u32) {
    st.unit_mut(id).expect("the unit exists").cur_hp = 0;
}

fn mark_recruited(st: &mut TacticalState, id: u32) {
    st.unit_mut(id).expect("the unit exists").state = UnitState::Recruited;
}

fn lvl(n: u8) -> Level {
    Level::new(n).expect("a valid level")
}

/// The carried XP total for a killer / victim level pair.
fn total_xp(killer_level: u8, bst: u16, victim_level: u8) -> u32 {
    battle_xp_reward(lvl(killer_level), bst, lvl(victim_level)).value()
}

fn cr(unit: u32, victim: u32, xp: u32, essence: u32, affinity: Affinity) -> Credit {
    Credit {
        unit,
        victim,
        xp,
        essence,
        affinity,
    }
}

/// The ledger after one successful hook call.
fn credited(st: &TacticalState, killer: u32, victim: u32, bst: u16) -> Ledger {
    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, st, killer, victim, bst).expect("the KO credits");
    ledger
}

/// A Wild battle, killer 1 (level `killer_level`, Fire) on side A with the first `n` of the
/// conscious teammates 2 (level 50, Wind), 3 (level 3, Plant), 4 (level 77, Earth), against the
/// victim 11 (level `victim_level`, `victim_affinity`, already Fainted) and a conscious wild 12.
fn wild_ko_with(
    killer_level: u8,
    victim_level: u8,
    victim_affinity: Affinity,
    n: usize,
) -> TacticalState {
    const TEAMMATES: [(u32, u8, Affinity); 3] = [
        (2, 50, Affinity::Wind),
        (3, 3, Affinity::Plant),
        (4, 77, Affinity::Earth),
    ];
    let mut specs: Vec<Spec> = vec![(1, Side::A, 0, killer_level, Affinity::Fire)];
    for (i, &(id, level, affinity)) in TEAMMATES.iter().take(n).enumerate() {
        specs.push((
            id,
            Side::A,
            u8::try_from(i + 1).expect("small"),
            level,
            affinity,
        ));
    }
    specs.push((11, Side::B, 0, victim_level, victim_affinity));
    specs.push((12, Side::B, 1, 20, Affinity::Dark));
    let mut st = world(BattleKind::Wild, &specs);
    faint(&mut st, 11);
    st
}

/// The standard wild KO: killer level 10, victim level 20 Water.
fn wild_ko(n: usize) -> TacticalState {
    wild_ko_with(10, 20, Affinity::Water, n)
}

/// A crowded wild fixture for the exclusion rules. Side A (slot order differs from id order):
/// killer 1 (L10 Fire), conscious teammates 6 (L3 Plant, slot 1) and 2 (L50 Wind, slot 2), a
/// Fainted 3, an Active-at-0-HP 4, a Recruited 5. Side B: the Fainted victim 11 (L20 Water), and
/// conscious wilds 12 and 13 (a conscious OTHER-side unit must never be paid).
fn pack() -> TacticalState {
    let mut st = world(
        BattleKind::Wild,
        &[
            (1, Side::A, 0, 10, Affinity::Fire),
            (6, Side::A, 1, 3, Affinity::Plant),
            (2, Side::A, 2, 50, Affinity::Wind),
            (3, Side::A, 3, 10, Affinity::Fire),
            (4, Side::A, 4, 10, Affinity::Fire),
            (5, Side::A, 5, 10, Affinity::Fire),
            (11, Side::B, 0, 20, Affinity::Water),
            (12, Side::B, 1, 20, Affinity::Dark),
            (13, Side::B, 2, 20, Affinity::Plant),
        ],
    );
    faint(&mut st, 3);
    at_zero_hp(&mut st, 4);
    mark_recruited(&mut st, 5);
    faint(&mut st, 11);
    st
}

// ===========================================================================
// BT5.6 - the ledger
// ===========================================================================

/// BT5.6: the wild XP split at hand-computed vectors - solo (100 % to the killer), n = 1 with an
/// odd total (the remainder goes to the killer: 133 -> 67 / 66), n = 2 and n = 3 with
/// `(total / 2) % n != 0` (135 -> 69 / 33 / 33 and 69 / 22 / 22 / 22), a tiny total, a large one -
/// with the killer's teammates at levels (50, 3, 77) unlike the killer's 10 (R8: the killer's
/// level alone sets the total). Each credit carries its victim; essence (victim's affinity) goes to
/// the killer only; currency is added once. Cross-checked against the carried reward fns.
/// Kills: `total / n`; a remainder lost or given to a teammate; ceil instead of floor; a teammate's
/// level used; essence shared; currency missing.
#[test]
fn the_wild_xp_split_matches_hand_computed_vectors_bt5_6() {
    // (bst, n, total, killer xp, each other xp, essence, currency)
    let rows: [(u16, usize, u32, u32, u32, u32, u64); 8] = [
        (330, 0, 133, 133, 0, 11, 33),
        (330, 1, 133, 67, 66, 11, 33),
        (330, 2, 133, 67, 33, 11, 33),
        (335, 2, 135, 69, 33, 11, 33),
        (335, 3, 135, 69, 22, 11, 33),
        (29, 1, 12, 6, 6, 1, 2),
        (1000, 3, 401, 203, 66, 33, 100),
        (1000, 1, 401, 201, 200, 33, 100),
    ];
    for (bst, n, total, killer_xp, other_xp, essence, currency) in rows {
        assert_eq!(total_xp(10, bst, 20), total, "carried XP for bst {bst}");
        assert_eq!(
            essence_battle_reward(bst),
            essence,
            "carried essence for bst {bst}"
        );
        assert_eq!(
            battle_currency_reward(bst),
            currency,
            "carried currency for bst {bst}"
        );

        let st = wild_ko(n);
        let ledger = credited(&st, 1, 11, bst);

        let mut want = vec![cr(1, 11, killer_xp, essence, Affinity::Water)];
        for id in 2..(2 + u32::try_from(n).expect("small")) {
            want.push(cr(id, 11, other_xp, 0, Affinity::Water));
        }
        assert_eq!(ledger.credits, want, "credits for bst {bst}, n {n}");
        assert_eq!(ledger.currency, currency, "currency for bst {bst}, n {n}");
        assert_eq!(
            want.iter().map(|x| x.xp).sum::<u32>(),
            total,
            "the split is exact for bst {bst}, n {n}"
        );
    }
}

/// BT5.6: only the killer's side's CONSCIOUS teammates share, and the credit order is the killer
/// first, then the teammates in ascending id (not slot) order. Fainted, Active-at-0-HP and
/// Recruited teammates and every unit of the other side - including conscious wilds - get nothing;
/// a Fainted killer is still credited (its forfeit is `pay`'s rule).
/// Kills: a teammate filter on `state` alone or `cur_hp` alone; sharing with the other side;
/// slot-order iteration; refusing a fainted killer.
#[test]
fn only_conscious_teammates_share_in_killer_then_ascending_id_order_bt5_6() {
    // total 135 (bst 335, L10 vs L20); teammates 2 and 6 -> n = 2: 33 each, killer 135 - 66 = 69.
    let want = vec![
        cr(1, 11, 69, 11, Affinity::Water),
        cr(2, 11, 33, 0, Affinity::Water),
        cr(6, 11, 33, 0, Affinity::Water),
    ];
    let st = pack();
    let ledger = credited(&st, 1, 11, 335);
    assert_eq!(ledger.credits, want);
    assert_eq!(ledger.currency, 33);

    let mut st = pack();
    faint(&mut st, 1);
    let ledger = credited(&st, 1, 11, 335);
    assert_eq!(
        ledger.credits, want,
        "a fainted killer is credited; the teammates' share is unchanged"
    );
}

/// BT5.6: over a grid (bst x killer level x victim level x n in 0..=3) the credits satisfy the
/// invariants: they sum to the carried total, every teammate gets `total / 2 / n`, the killer gets
/// `total - others`, essence is the killer's `essence_battle_reward`, currency is
/// `battle_currency_reward`, and a zero-xp teammate is not recorded.
/// Kills: any arithmetic drift away from the vectors, at levels and totals the vectors skip.
#[test]
fn the_xp_split_invariants_hold_over_a_grid_bt5_6() {
    for bst in [0u16, 1, 29, 330, 335, 1000, u16::MAX] {
        for killer_level in [1u8, 7, 10, 100] {
            for victim_level in [1u8, 20, 100] {
                for n in 0..=3usize {
                    let st = wild_ko_with(killer_level, victim_level, Affinity::Water, n);
                    let ledger = credited(&st, 1, 11, bst);
                    let total = total_xp(killer_level, bst, victim_level);
                    let n32 = u32::try_from(n).expect("small");
                    let each = if n == 0 { 0 } else { total / 2 / n32 };
                    let what = format!("bst {bst}, L{killer_level} vs L{victim_level}, n {n}");

                    assert_eq!(
                        ledger.credits.iter().map(|x| x.xp).sum::<u32>(),
                        total,
                        "{what}: the credits sum to the total"
                    );
                    let killer = &ledger.credits[0];
                    assert_eq!(killer.unit, 1, "{what}");
                    assert_eq!(killer.xp, total - each * n32, "{what}: the killer's share");
                    assert_eq!(killer.essence, essence_battle_reward(bst), "{what}");
                    let expected_len = if each > 0 { 1 + n } else { 1 };
                    assert_eq!(ledger.credits.len(), expected_len, "{what}");
                    for (i, other) in ledger.credits.iter().skip(1).enumerate() {
                        assert_eq!(other.unit, 2 + u32::try_from(i).expect("small"), "{what}");
                        assert_eq!(other.xp, each, "{what}: a teammate's share");
                        assert_eq!(other.essence, 0, "{what}");
                        assert_eq!(other.victim, 11, "{what}");
                    }
                    assert_eq!(ledger.currency, battle_currency_reward(bst), "{what}");
                }
            }
        }
    }
}

/// BT5.6: essence takes the VICTIM's affinity (for every credit), never the killer's or a
/// teammate's; currency is summed over KOs (33 + 2 over two victims) and saturates instead of
/// wrapping at `u64::MAX`.
/// Kills: the killer's affinity; essence to teammates; a currency overwrite; a wrapping add.
#[test]
fn essence_is_typed_by_the_victim_and_currency_accumulates_saturating_bt5_6() {
    for affinity in [Affinity::Fire, Affinity::Dark, Affinity::Light] {
        let st = wild_ko_with(10, 20, affinity, 1);
        let ledger = credited(&st, 1, 11, 330);
        assert_eq!(
            ledger.credits,
            vec![cr(1, 11, 67, 11, affinity), cr(2, 11, 66, 0, affinity)],
            "victim affinity {affinity:?}"
        );
    }

    // Two KOs by the same killer: victim 11 (bst 330, Water L20) then victim 12 (bst 29, Dark L20).
    // KO 2: total = 29 * 20 / 50 + 1 = 12; teammate 2 gets 12 / 2 / 1 = 6; killer 6; essence 1.
    let mut st = wild_ko(1);
    faint(&mut st, 12);
    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, &st, 1, 11, 330).expect("first KO");
    on_unit_defeated(&mut ledger, &st, 1, 12, 29).expect("second KO");
    assert_eq!(
        ledger.credits,
        vec![
            cr(1, 11, 67, 11, Affinity::Water),
            cr(2, 11, 66, 0, Affinity::Water),
            cr(1, 12, 6, 1, Affinity::Dark),
            cr(2, 12, 6, 0, Affinity::Dark),
        ]
    );
    assert_eq!(ledger.currency, 33 + 2);

    let mut near_max = Ledger {
        credits: vec![],
        currency: u64::MAX - 5,
    };
    on_unit_defeated(&mut near_max, &wild_ko(0), 1, 11, 330).expect("a KO credits");
    assert_eq!(near_max.currency, u64::MAX, "33 gold saturates at u64::MAX");
}

/// BT5.6: PvP pays essence to the killer on both sides - never XP, never currency, never a
/// teammate - typed by the victim's affinity, and a corrupt killer level (0) still pays (the level
/// is only read on the wild XP path). Also at bst 0 (essence floors at 1).
/// Kills: a Wild-only essence gate; an XP split in PvP; currency in PvP; a level check on PvP.
#[test]
fn pvp_pays_essence_to_the_killer_only_on_both_sides_bt5_6() {
    let fixture = |killer_level: u8| {
        world(
            BattleKind::Pvp,
            &[
                (1, Side::A, 0, killer_level, Affinity::Fire),
                (2, Side::A, 1, 10, Affinity::Wind),
                (11, Side::B, 0, 20, Affinity::Water),
                (12, Side::B, 1, 20, Affinity::Dark),
            ],
        )
    };

    let mut st = fixture(10);
    faint(&mut st, 11);
    let ledger = credited(&st, 1, 11, 330);
    assert_eq!(ledger.credits, vec![cr(1, 11, 0, 11, Affinity::Water)]);
    assert_eq!(ledger.currency, 0);

    let mut st = fixture(10);
    faint(&mut st, 2);
    let ledger = credited(&st, 12, 2, 335);
    assert_eq!(ledger.credits, vec![cr(12, 2, 0, 11, Affinity::Wind)]);
    assert_eq!(ledger.currency, 0);

    let mut st = fixture(0);
    faint(&mut st, 11);
    let ledger = credited(&st, 1, 11, 330);
    assert_eq!(
        ledger.credits,
        vec![cr(1, 11, 0, 11, Affinity::Water)],
        "a level-0 killer still earns PvP essence"
    );

    let mut st = fixture(10);
    faint(&mut st, 11);
    let ledger = credited(&st, 1, 11, 0);
    assert_eq!(ledger.credits, vec![cr(1, 11, 0, 1, Affinity::Water)]);
}

/// BT5.6: the no-pay KOs are `Ok` and write nothing - Practice (any killer), friendly fire (same
/// side, in a wild battle and in PvP), a wild killing a player-owned unit, a wild killing a wild -
/// and repeating one is again a no-op `Ok`. A non-empty ledger comes out byte-identical.
/// Kills: Practice rewards (self-vs-self farming); paying friendly fire; paying a wild's kill.
#[test]
fn practice_friendly_fire_and_wild_kills_pay_nothing_bt5_6() {
    let seeded = Ledger {
        credits: vec![cr(9, 99, 1, 1, Affinity::Fire)],
        currency: 7,
    };
    let specs = [
        (1, Side::A, 0, 10, Affinity::Fire),
        (2, Side::A, 1, 10, Affinity::Wind),
        (11, Side::B, 0, 20, Affinity::Water),
        (12, Side::B, 1, 20, Affinity::Dark),
    ];
    // (battle kind, killer, victim)
    let cases = [
        (BattleKind::Practice, 1, 11),
        (BattleKind::Practice, 11, 1),
        (BattleKind::Practice, 1, 2),
        (BattleKind::Wild, 1, 2),
        (BattleKind::Pvp, 1, 2),
        (BattleKind::Wild, 12, 2),
        (BattleKind::Wild, 12, 11),
    ];
    for (kind, killer, victim) in cases {
        let mut st = world(kind, &specs);
        faint(&mut st, victim);
        for ledger in [Ledger::default(), seeded.clone()] {
            let mut after = ledger.clone();
            assert_eq!(
                on_unit_defeated(&mut after, &st, killer, victim, 330),
                Ok(()),
                "{kind:?}: {killer} defeats {victim}"
            );
            assert_eq!(
                after, ledger,
                "{kind:?}: {killer} defeats {victim} pays nothing"
            );
            assert_eq!(
                on_unit_defeated(&mut after, &st, killer, victim, 330),
                Ok(()),
                "{kind:?}: repeating a no-op is a no-op"
            );
            assert_eq!(after, ledger);
        }
    }
}

/// BT5.6 / R3: a corrupt level zeroes XP ONLY. Killer or victim level 0 or above 100 on the wild
/// path: `Ok`, the killer's credit has xp 0 but its essence, the currency is still added, and no
/// teammate credit is recorded (their zero credit is skipped).
/// Kills: a level error that aborts the whole reward; essence / currency lost with the XP.
#[test]
fn a_bad_level_zeroes_the_xp_only_bt5_6() {
    for (killer_level, victim_level) in [(0u8, 20u8), (101, 20), (10, 0), (10, 101), (255, 255)] {
        let st = wild_ko_with(killer_level, victim_level, Affinity::Water, 1);
        let ledger = credited(&st, 1, 11, 330);
        assert_eq!(
            ledger.credits,
            vec![cr(1, 11, 0, 11, Affinity::Water)],
            "L{killer_level} vs L{victim_level}"
        );
        assert_eq!(ledger.currency, 33, "L{killer_level} vs L{victim_level}");
    }
}

/// BT5.6 / R9: a zero-value credit is not recorded. bst 0 at L10 vs L20 is total 1: the killer
/// keeps it (xp 1, essence 1), a teammate's `1 / 2 / n = 0` share (no essence) is skipped, for
/// n = 1 and n = 2; the currency is 0.
/// Kills: recording empty credits.
#[test]
fn zero_value_credits_are_not_recorded_bt5_6() {
    for n in [1usize, 2] {
        let st = wild_ko(n);
        assert_eq!(total_xp(10, 0, 20), 1);
        let ledger = credited(&st, 1, 11, 0);
        assert_eq!(
            ledger.credits,
            vec![cr(1, 11, 1, 1, Affinity::Water)],
            "n {n}"
        );
        assert_eq!(ledger.currency, 0);
    }
}

/// BT5.6: the errors, each leaving a non-empty ledger byte-identical, in the contract order:
/// UnknownUnit(killer) -> UnknownUnit(victim) -> NotDefeated(victim) (a conscious, an
/// Active-at-0-HP or a Recruited victim: a recruit never pays) -> AlreadyCredited(victim) (checked
/// before the no-op rules). A repeat of an accepted KO is refused and does not double the currency.
/// Kills: a wrong order; a half-written ledger on error; a second credit for one victim.
#[test]
fn the_reward_errors_leave_the_ledger_unchanged_in_contract_order_bt5_6() {
    let st = pack();
    let seeded = Ledger {
        credits: vec![cr(9, 99, 1, 1, Affinity::Fire)],
        currency: 7,
    };
    let credited_11 = Ledger {
        credits: vec![
            cr(9, 99, 1, 1, Affinity::Fire),
            cr(1, 11, 69, 11, Affinity::Water),
        ],
        currency: 40,
    };
    let credited_11_and_12 = Ledger {
        credits: vec![
            cr(1, 11, 69, 11, Affinity::Water),
            cr(1, 12, 5, 1, Affinity::Dark),
        ],
        currency: 40,
    };
    // (label, ledger, killer, victim, error)
    let cases: Vec<(&str, &Ledger, u32, u32, RewardError)> = vec![
        (
            "unknown killer",
            &seeded,
            77,
            11,
            RewardError::UnknownUnit { id: 77 },
        ),
        (
            "unknown victim",
            &seeded,
            1,
            78,
            RewardError::UnknownUnit { id: 78 },
        ),
        (
            "killer is checked first",
            &seeded,
            77,
            78,
            RewardError::UnknownUnit { id: 77 },
        ),
        (
            "a conscious victim",
            &seeded,
            1,
            12,
            RewardError::NotDefeated { id: 12 },
        ),
        (
            "an active 0-HP victim",
            &seeded,
            1,
            4,
            RewardError::NotDefeated { id: 4 },
        ),
        (
            "a recruited victim",
            &seeded,
            1,
            5,
            RewardError::NotDefeated { id: 5 },
        ),
        (
            "already credited",
            &credited_11,
            1,
            11,
            RewardError::AlreadyCredited { id: 11 },
        ),
        (
            "already credited by another killer",
            &credited_11,
            6,
            11,
            RewardError::AlreadyCredited { id: 11 },
        ),
        (
            "already credited beats the no-op rules",
            &credited_11,
            12,
            11,
            RewardError::AlreadyCredited { id: 11 },
        ),
        (
            "not defeated beats already credited",
            &credited_11_and_12,
            1,
            12,
            RewardError::NotDefeated { id: 12 },
        ),
    ];
    for (label, ledger, killer, victim, want) in cases {
        let mut working = ledger.clone();
        assert_eq!(
            on_unit_defeated(&mut working, &st, killer, victim, 335),
            Err(want),
            "{label}"
        );
        assert_eq!(&working, ledger, "{label}: the ledger is unchanged");
    }

    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, &st, 1, 11, 335).expect("the first KO credits");
    let after_first = ledger.clone();
    assert_eq!(after_first.currency, 33);
    assert_eq!(
        on_unit_defeated(&mut ledger, &st, 1, 11, 335),
        Err(RewardError::AlreadyCredited { id: 11 })
    );
    assert_eq!(
        ledger, after_first,
        "the repeat adds no credit and no currency"
    );
}

// ===========================================================================
// BT5.7 - paying the ledger at battle end
// ===========================================================================

/// The unit roster of the `pay` fixtures: side A 1..=7, side B 11; the final state has 3 Fainted,
/// 4 Active-at-0-HP and 5 Recruited (and 8 / 9 / 10 absent: benched).
fn pay_state() -> TacticalState {
    let mut st = world(
        BattleKind::Wild,
        &[
            (1, Side::A, 0, 10, Affinity::Fire),
            (2, Side::A, 1, 10, Affinity::Fire),
            (3, Side::A, 2, 10, Affinity::Fire),
            (4, Side::A, 3, 10, Affinity::Fire),
            (5, Side::A, 4, 10, Affinity::Fire),
            (6, Side::A, 5, 10, Affinity::Fire),
            (7, Side::A, 6, 10, Affinity::Fire),
            (11, Side::B, 0, 20, Affinity::Water),
        ],
    );
    faint(&mut st, 3);
    at_zero_hp(&mut st, 4);
    mark_recruited(&mut st, 5);
    st
}

/// A ledger with credits in a deliberately scrambled unit / affinity order.
fn scrambled_ledger() -> Ledger {
    Ledger {
        credits: vec![
            cr(1, 14, 0, 3, Affinity::Dark),
            cr(1, 12, 10, 4, Affinity::Water),
            cr(1, 11, 67, 11, Affinity::Fire),
            cr(1, 13, 5, 5, Affinity::Fire),
            cr(2, 11, 66, 0, Affinity::Fire),
            cr(3, 11, 40, 2, Affinity::Fire),
            cr(4, 11, 40, 2, Affinity::Fire),
            cr(5, 11, 40, 2, Affinity::Fire),
            cr(9, 11, 40, 2, Affinity::Fire),
            cr(6, 11, 0, 0, Affinity::Fire),
            cr(7, 12, 0, 2, Affinity::Earth),
        ],
        currency: 35,
    }
}

fn scrambled_payout() -> Payout {
    Payout {
        awards: vec![
            Award {
                unit: 1,
                xp: 82,
                essence: vec![
                    (Affinity::Fire, 16),
                    (Affinity::Water, 4),
                    (Affinity::Dark, 3),
                ],
            },
            Award {
                unit: 2,
                xp: 66,
                essence: vec![],
            },
            Award {
                unit: 7,
                xp: 0,
                essence: vec![(Affinity::Earth, 2)],
            },
        ],
        currency: 35,
    }
}

/// BT5.7: `pay` sums per unit (xp 0 + 10 + 67 + 5 = 82) and per (unit, affinity) (Fire 11 + 5 = 16,
/// Water 4, Dark 3), lists awards by ascending unit and essence by ascending affinity index (not
/// credit order), omits a unit whose xp and essence are both 0 (unit 6), keeps a unit with essence
/// but no xp (unit 7) and one with xp but no essence (unit 2, empty vec), and pays only the units
/// CONSCIOUS in the final state: the Fainted 3, the Active-at-0-HP 4, the Recruited 5 and the
/// absent (benched) 9 are skipped. The currency is paid unchanged.
/// Kills: first-seen essence order; summing by affinity wrongly; paying the unconscious.
#[test]
fn pay_sums_per_unit_and_affinity_and_pays_only_the_conscious_bt5_7() {
    assert_eq!(pay(&scrambled_ledger(), &pay_state()), scrambled_payout());
    assert_eq!(pay(&Ledger::default(), &pay_state()), Payout::default());
}

/// BT5.7: a Fainted killer forfeits its credit and the teammates are NOT topped up; conscious
/// ones keep exactly what was recorded. (Control: the same ledger with the killer conscious pays
/// all three.)
/// Kills: redistributing a fainted unit's share; re-splitting at pay time.
#[test]
fn a_fainted_killer_forfeits_and_nobody_is_topped_up_bt5_7() {
    let ledger = Ledger {
        credits: vec![
            cr(1, 11, 69, 11, Affinity::Water),
            cr(2, 11, 33, 0, Affinity::Water),
            cr(6, 11, 33, 0, Affinity::Water),
        ],
        currency: 33,
    };
    let mut st = pack();
    assert_eq!(
        pay(&ledger, &st),
        Payout {
            awards: vec![
                Award {
                    unit: 1,
                    xp: 69,
                    essence: vec![(Affinity::Water, 11)],
                },
                Award {
                    unit: 2,
                    xp: 33,
                    essence: vec![],
                },
                Award {
                    unit: 6,
                    xp: 33,
                    essence: vec![],
                },
            ],
            currency: 33,
        }
    );
    faint(&mut st, 1);
    assert_eq!(
        pay(&ledger, &st),
        Payout {
            awards: vec![
                Award {
                    unit: 2,
                    xp: 33,
                    essence: vec![],
                },
                Award {
                    unit: 6,
                    xp: 33,
                    essence: vec![],
                },
            ],
            currency: 33,
        },
        "the forfeited 69 xp and 11 essence vanish"
    );
}

/// BT5.7: the same ledger and units pay the same `Payout` on every terminal outcome - a win, a
/// loss, Fled (voluntary, clock, round cap and disconnect all end `Fled`) - and even on a state
/// still `Ongoing`; `pay` never branches on the outcome. A loss with no survivor pays no award but
/// still pays the currency.
/// Kills: a pay that depends on the outcome (e.g. pays only on a win); currency lost on a loss.
#[test]
fn pay_is_identical_on_every_terminal_outcome_bt5_7() {
    let ledger = scrambled_ledger();
    for outcome in [
        BattleOutcome::SideAWins,
        BattleOutcome::SideBWins,
        BattleOutcome::Fled,
        BattleOutcome::Ongoing,
    ] {
        let mut st = pay_state();
        st.outcome = outcome;
        assert_eq!(pay(&ledger, &st), scrambled_payout(), "{outcome:?}");
    }

    let mut wiped = pay_state();
    for id in [1, 2, 6, 7] {
        faint(&mut wiped, id);
    }
    wiped.outcome = BattleOutcome::SideBWins;
    assert_eq!(
        pay(&ledger, &wiped),
        Payout {
            awards: vec![],
            currency: 35,
        },
        "a total loss pays the currency and no award"
    );
}

/// BT5.7 / A3: the sums saturate - two `u32::MAX` xp credits (and essence) for one unit give
/// `u32::MAX`, not a wrap or a panic.
/// Kills: a plain `+` under overflow-checks.
#[test]
fn pay_saturates_instead_of_overflowing_bt5_7() {
    let ledger = Ledger {
        credits: vec![
            cr(1, 11, u32::MAX, u32::MAX, Affinity::Fire),
            cr(1, 12, 5, 7, Affinity::Fire),
            cr(1, 13, u32::MAX, 1, Affinity::Water),
        ],
        currency: 0,
    };
    assert_eq!(
        pay(&ledger, &pay_state()),
        Payout {
            awards: vec![Award {
                unit: 1,
                xp: u32::MAX,
                essence: vec![(Affinity::Fire, u32::MAX), (Affinity::Water, 1)],
            }],
            currency: 0,
        }
    );
}

/// BT5.6 + BT5.7 end to end: two KOs through the hook (killer 1 L10 takes wild 11 with teammate 2
/// L8 conscious; then teammate 2 takes wild 12 L4 with 1 conscious), then `pay`. KO 1: bst 335,
/// L10 vs L20 -> total 135: teammate 2 gets 67, killer 68, essence 11 Water. KO 2: bst 29, L8
/// vs L4 -> `29 * 4 / (5 * 8) + 1 = 3`: teammate 1 gets `3 / 2 / 1 = 1`, killer 2 gets 2, essence
/// `max(1, 0) = 1` Dark. Payout: unit 1 = 68 + 1 = 69 xp, Water 11; unit 2 = 67 + 2 = 69 xp, Dark 1;
/// currency 33 + 2 = 35. If unit 2 has fainted by the end it forfeits everything.
/// Kills: a hook / pay pair that disagree on credits, victims, or the currency.
#[test]
fn the_ledger_pays_what_the_hook_recorded_bt5_7() {
    let mut st = world(
        BattleKind::Wild,
        &[
            (1, Side::A, 0, 10, Affinity::Fire),
            (2, Side::A, 1, 8, Affinity::Wind),
            (11, Side::B, 0, 20, Affinity::Water),
            (12, Side::B, 1, 4, Affinity::Dark),
        ],
    );
    assert_eq!(total_xp(10, 335, 20), 135);
    assert_eq!(total_xp(8, 29, 4), 3);

    faint(&mut st, 11);
    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, &st, 1, 11, 335).expect("KO 1");
    faint(&mut st, 12);
    on_unit_defeated(&mut ledger, &st, 2, 12, 29).expect("KO 2");

    assert_eq!(
        ledger.credits,
        vec![
            cr(1, 11, 68, 11, Affinity::Water),
            cr(2, 11, 67, 0, Affinity::Water),
            cr(2, 12, 2, 1, Affinity::Dark),
            cr(1, 12, 1, 0, Affinity::Dark),
        ]
    );
    assert_eq!(ledger.currency, 35);

    assert_eq!(
        pay(&ledger, &st),
        Payout {
            awards: vec![
                Award {
                    unit: 1,
                    xp: 69,
                    essence: vec![(Affinity::Water, 11)],
                },
                Award {
                    unit: 2,
                    xp: 69,
                    essence: vec![(Affinity::Dark, 1)],
                },
            ],
            currency: 35,
        }
    );

    faint(&mut st, 2);
    assert_eq!(
        pay(&ledger, &st),
        Payout {
            awards: vec![Award {
                unit: 1,
                xp: 69,
                essence: vec![(Affinity::Water, 11)],
            }],
            currency: 35,
        },
        "a unit fainted at the end forfeits all of its credits"
    );
}
