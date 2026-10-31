//! bt-3 gating tests for `tactics::clock` — BT3.9, the pure window / pad / reset / window-count /
//! strike arithmetic over supplied timestamps. Every expected value is the contract's arithmetic
//! at `TacticsTuning::DESIGN` (30 000 / 300 000 ms windows, 45 000 / 300 000 ms deploy, pad cap
//! 5 000, 3 windows per unit-turn, the 4th auto-pass forfeits) or at a perturbed tuning (the
//! "read from the tuning" probe). Test names end in `_bt3_9`.

use super::clock::{
    accept_submit, begin_unit_turn, deploy_budget_ms, expire, open_window, window_budget_ms,
    ClockError, ClockState, Expiry, Window,
};
use super::resolve_tests::{design, perturb};
use super::tuning::BattleKind;

const T0: i64 = 1_000_000;

/// A clock with a window open at `opens_at` (deadline `opens_at + 30 000`), `windows` opened
/// this unit-turn and the given counters.
fn open_clock(seq: u32, opens_at: i64, windows: u8, idle: u64, strikes: u8) -> ClockState {
    ClockState {
        window_seq: seq,
        window_open_ms: Some(opens_at),
        deadline_ms: Some(opens_at + 30_000),
        windows_this_unit_turn: windows,
        idle_ms_total: idle,
        autopass_count: strikes,
    }
}

/// BT3.9: the per-window budget is 300 000 ms in a wild battle and 30 000 ms under the PvP
/// ruleset — Practice included — read from the tuning.
/// Kills: `match kind { Pvp => .. }` (Practice on the PvE budget); hard-coded numbers.
#[test]
fn the_window_budget_is_thirty_seconds_under_pvp_rules_and_five_minutes_wild_bt3_9() {
    let t = design();
    assert_eq!(window_budget_ms(BattleKind::Wild, &t), 300_000);
    assert_eq!(window_budget_ms(BattleKind::Pvp, &t), 30_000);
    assert_eq!(window_budget_ms(BattleKind::Practice, &t), 30_000);
    let odd = perturb(|t| {
        t.pvp_window_ms = 12_345;
        t.pve_window_ms = 54_321;
    });
    assert_eq!(window_budget_ms(BattleKind::Wild, &odd), 54_321);
    assert_eq!(window_budget_ms(BattleKind::Pvp, &odd), 12_345);
    assert_eq!(window_budget_ms(BattleKind::Practice, &odd), 12_345);
}

/// BT3.9: deploy windows are 45 000 ms under the PvP ruleset (Practice included) and 300 000 ms
/// wild, read from the tuning.
/// Kills: the per-window budget returned for deploy; Practice on the PvE deploy clock.
#[test]
fn the_deploy_budget_is_forty_five_seconds_under_pvp_rules_and_five_minutes_wild_bt3_9() {
    let t = design();
    assert_eq!(deploy_budget_ms(BattleKind::Wild, &t), 300_000);
    assert_eq!(deploy_budget_ms(BattleKind::Pvp, &t), 45_000);
    assert_eq!(deploy_budget_ms(BattleKind::Practice, &t), 45_000);
    let odd = perturb(|t| {
        t.pvp_deploy_ms = 7_777;
        t.pve_deploy_ms = 8_888;
    });
    assert_eq!(deploy_budget_ms(BattleKind::Wild, &odd), 8_888);
    assert_eq!(deploy_budget_ms(BattleKind::Pvp, &odd), 7_777);
    assert_eq!(deploy_budget_ms(BattleKind::Practice, &odd), 7_777);
}

/// BT3.9: a window opens at `t0 + pad` with `deadline = t0 + pad + budget`, `window_seq += 1`
/// and `windows_this_unit_turn += 1`; both timestamps are stored and nothing else moves.
/// Kills: the deadline from t0 (pad not counted); seq not advanced; the window not stored.
#[test]
fn open_window_opens_at_t0_plus_pad_with_the_full_budget_bt3_9() {
    let t = design();
    let mut clock = ClockState::default();
    assert_eq!(
        open_window(&mut clock, T0, 2_600, BattleKind::Pvp, &t),
        Ok(Window {
            seq: 1,
            opens_at_ms: T0 + 2_600,
            deadline_ms: T0 + 32_600,
        })
    );
    assert_eq!(
        clock,
        ClockState {
            window_seq: 1,
            window_open_ms: Some(T0 + 2_600),
            deadline_ms: Some(T0 + 32_600),
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 0,
        }
    );

    let mut later = ClockState {
        window_seq: 7,
        window_open_ms: None,
        deadline_ms: None,
        windows_this_unit_turn: 1,
        idle_ms_total: 99,
        autopass_count: 2,
    };
    assert_eq!(
        open_window(&mut later, T0, 0, BattleKind::Wild, &t),
        Ok(Window {
            seq: 8,
            opens_at_ms: T0,
            deadline_ms: T0 + 300_000,
        })
    );
    assert_eq!(
        later,
        ClockState {
            window_seq: 8,
            window_open_ms: Some(T0),
            deadline_ms: Some(T0 + 300_000),
            windows_this_unit_turn: 2,
            idle_ms_total: 99,
            autopass_count: 2,
        }
    );
}

/// BT3.9: the pad is capped at `pad_cap_ms` (5 000) — 9 000 opens at t0 + 5 000, 5 000 and
/// 4 999 are kept — and the cap is read from the tuning.
/// Kills: no cap; `<` for `≤` at the cap; a hard-coded 5 000.
#[test]
fn the_pad_is_capped_at_five_seconds_bt3_9() {
    let t = design();
    for (pad, opens) in [
        (9_000u32, 5_000i64),
        (5_001, 5_000),
        (5_000, 5_000),
        (4_999, 4_999),
        (u32::MAX, 5_000),
    ] {
        let mut clock = ClockState::default();
        let w = open_window(&mut clock, T0, pad, BattleKind::Pvp, &t).expect("a fresh clock opens");
        assert_eq!(
            (w.opens_at_ms, w.deadline_ms),
            (T0 + opens, T0 + opens + 30_000),
            "pad {pad}"
        );
    }
    let tight = perturb(|t| t.pad_cap_ms = 1_200);
    let mut clock = ClockState::default();
    let w = open_window(&mut clock, T0, 2_600, BattleKind::Wild, &tight).expect("opens");
    assert_eq!(w.opens_at_ms, T0 + 1_200);
}

/// BT3.9: a second open while one is open is `AlreadyOpen`, and the 4th open of a unit-turn is
/// `WindowCap { windows: 3, cap: 3 }` — refused, never clamped, the clock untouched; an open
/// window is reported before the cap.
/// Kills: a 4th window opened; the cap clamped (window reused); `>` for `≥` against the cap.
#[test]
fn open_window_refuses_an_open_window_and_a_fourth_window_bt3_9() {
    let t = design();
    let mut clock = ClockState::default();
    open_window(&mut clock, T0, 0, BattleKind::Pvp, &t).expect("first window");
    let before = clock;
    assert_eq!(
        open_window(&mut clock, T0 + 5, 0, BattleKind::Pvp, &t),
        Err(ClockError::AlreadyOpen)
    );
    assert_eq!(clock, before);

    accept_submit(&mut clock, T0 + 10).expect("close the first");
    open_window(&mut clock, T0 + 20, 0, BattleKind::Pvp, &t).expect("second window");
    accept_submit(&mut clock, T0 + 30).expect("close the second");
    open_window(&mut clock, T0 + 40, 0, BattleKind::Pvp, &t).expect("third window");
    accept_submit(&mut clock, T0 + 50).expect("close the third");
    assert_eq!(clock.windows_this_unit_turn, 3);
    let capped = clock;
    assert_eq!(
        open_window(&mut clock, T0 + 60, 0, BattleKind::Pvp, &t),
        Err(ClockError::WindowCap { windows: 3, cap: 3 })
    );
    assert_eq!(clock, capped, "a refused open changes nothing");

    let mut both = open_clock(4, T0, 3, 0, 0);
    let snapshot = both;
    assert_eq!(
        open_window(&mut both, T0, 0, BattleKind::Pvp, &t),
        Err(ClockError::AlreadyOpen),
        "AlreadyOpen is checked before the cap"
    );
    assert_eq!(both, snapshot);

    let one = perturb(|t| t.max_windows_per_turn = 1);
    let mut clock = ClockState::default();
    open_window(&mut clock, T0, 0, BattleKind::Pvp, &one).expect("the only window");
    accept_submit(&mut clock, T0 + 1).expect("closed");
    assert_eq!(
        open_window(&mut clock, T0 + 2, 0, BattleKind::Pvp, &one),
        Err(ClockError::WindowCap { windows: 1, cap: 1 })
    );
}

/// BT3.9: `begin_unit_turn` zeroes `windows_this_unit_turn` and nothing else (seq, the open
/// window, idle and strikes survive), so a new unit-turn may open 3 windows again.
/// Kills: strikes or the seq reset with the unit-turn; the window closed by it.
#[test]
fn begin_unit_turn_resets_only_the_window_count_bt3_9() {
    let mut clock = open_clock(9, T0, 3, 1_234, 2);
    begin_unit_turn(&mut clock);
    assert_eq!(
        clock,
        ClockState {
            windows_this_unit_turn: 0,
            ..open_clock(9, T0, 3, 1_234, 2)
        }
    );
    accept_submit(&mut clock, T0).expect("close it");
    let w = open_window(&mut clock, T0 + 1, 0, BattleKind::Pvp, &design())
        .expect("a fresh unit-turn opens again");
    assert_eq!(w.seq, 10);
    assert_eq!(clock.windows_this_unit_turn, 1);
}

/// BT3.9: an accepted submit closes the window and books `max(0, t − opens_at)` as idle
/// (returned and added to `idle_ms_total`); a submit inside the pad books 0; one after the
/// deadline is still accepted.
/// Kills: idle measured from t0 (pad counted); the window left open; a negative idle; a submit
/// after the deadline refused.
#[test]
fn accept_submit_closes_the_window_and_books_the_idle_time_bt3_9() {
    let mut clock = open_clock(3, T0 + 2_000, 1, 500, 0);
    assert_eq!(accept_submit(&mut clock, T0 + 9_000), Ok(7_000));
    assert_eq!(
        clock,
        ClockState {
            window_seq: 3,
            window_open_ms: None,
            deadline_ms: None,
            windows_this_unit_turn: 1,
            idle_ms_total: 7_500,
            autopass_count: 0,
        }
    );

    let mut early = open_clock(3, T0 + 2_000, 1, 500, 0);
    assert_eq!(accept_submit(&mut early, T0 + 100), Ok(0));
    assert_eq!(early.idle_ms_total, 500);
    assert_eq!((early.window_open_ms, early.deadline_ms), (None, None));

    let mut at_open = open_clock(3, T0, 1, 0, 0);
    assert_eq!(accept_submit(&mut at_open, T0), Ok(0));

    let mut late = open_clock(3, T0, 1, 0, 0);
    assert_eq!(accept_submit(&mut late, T0 + 40_000), Ok(40_000));
}

/// BT3.9: with no window open, `accept_submit` is `NoWindow` and the clock is untouched.
/// Kills: a closed clock booking idle from a stale `window_open_ms`.
#[test]
fn accept_submit_without_a_window_is_no_window_bt3_9() {
    let mut clock = ClockState {
        window_seq: 2,
        window_open_ms: None,
        deadline_ms: None,
        windows_this_unit_turn: 2,
        idle_ms_total: 10,
        autopass_count: 1,
    };
    let before = clock;
    assert_eq!(accept_submit(&mut clock, T0), Err(ClockError::NoWindow));
    assert_eq!(clock, before);
}

/// BT3.9: an expiry under the PvP ruleset closes the window and strikes: 1, 2, 3 are
/// `forfeit: false`, the 4th is `forfeit: true` (and a 5th stays true); the count never resets
/// across `begin_unit_turn` / `open_window`. Idle is not booked by an expiry.
/// Kills: forfeit at `> 4`; the count reset per unit-turn; the window left open.
#[test]
fn expiry_under_pvp_rules_strikes_and_the_fourth_forfeits_bt3_9() {
    let t = design();
    let mut clock = ClockState::default();
    let mut now = T0;
    for strike in 1..=5u8 {
        begin_unit_turn(&mut clock);
        let w = open_window(&mut clock, now, 0, BattleKind::Pvp, &t).expect("opens");
        now = w.deadline_ms;
        assert_eq!(
            expire(&mut clock, now, BattleKind::Pvp, &t),
            Ok(Expiry::AutoPass {
                strike,
                forfeit: strike >= 4,
            }),
            "strike {strike}"
        );
        assert_eq!(clock.autopass_count, strike);
        assert_eq!((clock.window_open_ms, clock.deadline_ms), (None, None));
        assert_eq!(clock.idle_ms_total, 0, "an expiry books no idle");
        now += 1;
    }

    let two = perturb(|t| t.autopass_forfeit = 2);
    let mut clock = open_clock(1, T0, 1, 0, 1);
    assert_eq!(
        expire(&mut clock, T0 + 30_000, BattleKind::Pvp, &two),
        Ok(Expiry::AutoPass {
            strike: 2,
            forfeit: true
        })
    );

    let mut practice = open_clock(1, T0, 1, 0, 3);
    assert_eq!(
        expire(&mut practice, T0 + 30_000, BattleKind::Practice, &t),
        Ok(Expiry::AutoPass {
            strike: 4,
            forfeit: true
        }),
        "Practice runs the PvP ruleset"
    );

    let mut saturated = open_clock(1, T0, 1, 0, u8::MAX);
    assert_eq!(
        expire(&mut saturated, T0 + 30_000, BattleKind::Pvp, &t),
        Ok(Expiry::AutoPass {
            strike: u8::MAX,
            forfeit: true
        }),
        "the count saturates"
    );
}

/// BT3.9: a wild expiry is `AutoFlee`: the window closes and no strike is counted.
/// Kills: a wild battle striking; AutoPass in a wild battle.
#[test]
fn expiry_in_a_wild_battle_auto_flees_without_a_strike_bt3_9() {
    let t = design();
    let mut clock = ClockState::default();
    let w = open_window(&mut clock, T0, 0, BattleKind::Wild, &t).expect("opens");
    assert_eq!(w.deadline_ms, T0 + 300_000);
    assert_eq!(
        expire(&mut clock, T0 + 300_000, BattleKind::Wild, &t),
        Ok(Expiry::AutoFlee)
    );
    assert_eq!(
        clock,
        ClockState {
            window_seq: 1,
            window_open_ms: None,
            deadline_ms: None,
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 0,
        }
    );
}

/// BT3.9: an expiry before the deadline is `NotDue { deadline_ms }` and changes nothing; at the
/// deadline exactly it fires; with no window open it is `NoWindow`.
/// Kills: a premature fire honoured; `>` for `≥` at the deadline.
#[test]
fn expiry_before_the_deadline_or_without_a_window_changes_nothing_bt3_9() {
    let t = design();
    let mut clock = open_clock(5, T0, 2, 77, 1);
    let before = clock;
    assert_eq!(
        expire(&mut clock, T0 + 29_999, BattleKind::Pvp, &t),
        Err(ClockError::NotDue {
            deadline_ms: T0 + 30_000
        })
    );
    assert_eq!(clock, before);
    assert_eq!(
        expire(&mut clock, T0 + 30_000, BattleKind::Pvp, &t),
        Ok(Expiry::AutoPass {
            strike: 2,
            forfeit: false
        })
    );

    let closed_before = clock;
    assert_eq!(
        expire(&mut clock, T0 + 99_999, BattleKind::Pvp, &t),
        Err(ClockError::NoWindow)
    );
    assert_eq!(clock, closed_before);
    let mut wild_closed = ClockState::default();
    assert_eq!(
        expire(&mut wild_closed, T0, BattleKind::Wild, &t),
        Err(ClockError::NoWindow)
    );
    assert_eq!(wild_closed, ClockState::default());
}

/// BT3.9: the i64 edges saturate instead of trapping — a window opened near `i64::MAX` stores
/// `i64::MAX`, and the widest possible idle span books `u64::MAX` (into a saturating total).
/// Kills: plain `+` / `-` on the timestamps (an overflow panic in debug).
#[test]
fn the_clock_saturates_at_the_timestamp_edges_bt3_9() {
    let t = design();
    let mut clock = ClockState::default();
    let w = open_window(&mut clock, i64::MAX - 10, 5_000, BattleKind::Wild, &t)
        .expect("a window near the end of time still opens");
    assert_eq!(
        w,
        Window {
            seq: 1,
            opens_at_ms: i64::MAX,
            deadline_ms: i64::MAX,
        }
    );
    assert_eq!(clock.window_open_ms, Some(i64::MAX));
    assert_eq!(
        accept_submit(&mut clock, i64::MIN),
        Ok(0),
        "a negative span books 0"
    );

    let mut wide = ClockState {
        window_seq: 1,
        window_open_ms: Some(i64::MIN),
        deadline_ms: Some(i64::MIN),
        windows_this_unit_turn: 1,
        idle_ms_total: 5,
        autopass_count: 0,
    };
    assert_eq!(accept_submit(&mut wide, i64::MAX), Ok(u64::MAX));
    assert_eq!(wide.idle_ms_total, u64::MAX, "the total saturates");
}
