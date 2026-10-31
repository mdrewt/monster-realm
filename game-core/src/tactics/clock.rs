//! The idle clock — design §2.3 "Idle clock", §6.2: pure window / pad / reset / window-count /
//! strike arithmetic over SUPPLIED timestamps. The server-module schedules the deadline rows
//! (bt-8) and persists [`ClockState`] flat in `battle_clock`; nothing here reads a wall clock.
//!
//! One [`ClockState`] per player (per side). A window opens when the battle enters `Waiting(U)`
//! for one of that player's units, at `t0 + pad` (`pad` = Σ presentation caps of the events
//! emitted since the last Waiting, capped at `pad_cap_ms`, so animations never count — D583.2),
//! with `deadline = t0 + pad + BUDGET` and `window_seq += 1`. An accepted submit CLOSES the window
//! and books `max(0, t − (t0 + pad))` as idle time (the literal reset-on-submit ruling, §12 Q1); a
//! rejected submit is not a clock event at all — there is deliberately no function for it. A
//! unit-turn never opens more than `max_windows_per_turn` windows: every window after the first
//! needs ≥ 2 AP left and every accepted live submit that does not end the turn spends ≥ 2 AP
//! (6 → 4 → 2), so the cap is structural; [`open_window`] still REFUSES a window past it rather
//! than clamp. Expiry → PvP ruleset: `AutoPass` and one strike (the `autopass_forfeit`-th of the
//! match forfeits; the count never resets); Wild: `AutoFlee`.

use serde::{Deserialize, Serialize};

use super::tuning::{BattleKind, TacticsTuning};

/// One player's clock (`battle_clock` row). `Default` = no window ever opened.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClockState {
    /// Incremented on every window opened; the scheduled row's arg-identity pin.
    pub window_seq: u32,
    /// `t0 + pad` of the open window, `None` when no window is open.
    pub window_open_ms: Option<i64>,
    /// `t0 + pad + BUDGET` of the open window, `None` when no window is open.
    pub deadline_ms: Option<i64>,
    /// Windows opened during the current unit-turn (reset by [`begin_unit_turn`]).
    pub windows_this_unit_turn: u8,
    /// Telemetry: total idle milliseconds booked by accepted submits.
    pub idle_ms_total: u64,
    /// PvP strikes this match (never reset).
    pub autopass_count: u8,
}

/// An opened window: what the server arms its deadline row with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub seq: u32,
    pub opens_at_ms: i64,
    pub deadline_ms: i64,
}

/// Why a clock operation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClockError {
    /// `open_window` while a window is already open.
    AlreadyOpen,
    /// `open_window` past `max_windows_per_turn` (reject, never clamp).
    WindowCap { windows: u8, cap: u8 },
    /// `accept_submit` / `expire` with no open window.
    NoWindow,
    /// `expire` before the deadline (a premature fire).
    NotDue { deadline_ms: i64 },
}

/// What an expired window does to the battle (the explicit input game-core receives, §2.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Expiry {
    /// PvP ruleset: the unit's turn ends uncommitted; `strike` is the owner's new count and
    /// `forfeit` whether it reached `autopass_forfeit`.
    AutoPass { strike: u8, forfeit: bool },
    /// Wild: the battle flees (damaged HP persists).
    AutoFlee,
}

/// The per-window budget: `pvp_window_ms` under the PvP ruleset, `pve_window_ms` for a wild battle.
#[must_use]
pub fn window_budget_ms(kind: BattleKind, t: &TacticsTuning) -> u32 {
    if kind.uses_pvp_rules() {
        t.pvp_window_ms
    } else {
        t.pve_window_ms
    }
}

/// The deploy window: `pvp_deploy_ms` under the PvP ruleset, `pve_deploy_ms` for a wild battle.
#[must_use]
pub fn deploy_budget_ms(kind: BattleKind, t: &TacticsTuning) -> u32 {
    if kind.uses_pvp_rules() {
        t.pvp_deploy_ms
    } else {
        t.pve_deploy_ms
    }
}

/// A fresh unit-turn for this player: `windows_this_unit_turn = 0`; nothing else changes.
pub fn begin_unit_turn(clock: &mut ClockState) {
    clock.windows_this_unit_turn = 0;
}

/// Open a window at `now_ms + min(pad_ms, pad_cap_ms)` with `deadline = opens_at + budget`
/// (saturating i64 arithmetic), advancing `window_seq` and `windows_this_unit_turn`. The pad
/// cap is applied here, once.
///
/// # Errors
/// `AlreadyOpen` when a window is open; `WindowCap` when `windows_this_unit_turn ≥
/// max_windows_per_turn` — in that order; the clock is untouched on `Err`.
pub fn open_window(
    clock: &mut ClockState,
    now_ms: i64,
    pad_ms: u32,
    kind: BattleKind,
    t: &TacticsTuning,
) -> Result<Window, ClockError> {
    if clock.window_open_ms.is_some() {
        return Err(ClockError::AlreadyOpen);
    }
    if clock.windows_this_unit_turn >= t.max_windows_per_turn {
        return Err(ClockError::WindowCap {
            windows: clock.windows_this_unit_turn,
            cap: t.max_windows_per_turn,
        });
    }
    let opens_at_ms = now_ms.saturating_add(i64::from(pad_ms.min(t.pad_cap_ms)));
    let deadline_ms = opens_at_ms.saturating_add(i64::from(window_budget_ms(kind, t)));
    clock.window_seq = clock.window_seq.wrapping_add(1);
    clock.windows_this_unit_turn = clock.windows_this_unit_turn.saturating_add(1);
    clock.window_open_ms = Some(opens_at_ms);
    clock.deadline_ms = Some(deadline_ms);
    Ok(Window {
        seq: clock.window_seq,
        opens_at_ms,
        deadline_ms,
    })
}

/// An accepted submit at `now_ms` closes the window and books `max(0, now − opens_at)` as idle
/// (i128 difference, saturating into `u64` and into `idle_ms_total`); returns the idle booked. A
/// submit after the deadline is still accepted — the submit and the fire race, and whichever
/// transaction commits first wins (the fire then finds the window closed: stale, a no-op).
///
/// # Errors
/// `NoWindow` when none is open (the clock is untouched).
pub fn accept_submit(clock: &mut ClockState, now_ms: i64) -> Result<u64, ClockError> {
    let opens_at_ms = clock.window_open_ms.ok_or(ClockError::NoWindow)?;
    let span = i128::from(now_ms) - i128::from(opens_at_ms);
    let idle = u64::try_from(span.max(0)).unwrap_or(u64::MAX);
    clock.idle_ms_total = clock.idle_ms_total.saturating_add(idle);
    clock.window_open_ms = None;
    clock.deadline_ms = None;
    Ok(idle)
}

/// The open window expired at `now_ms`: closes it; under the PvP ruleset `autopass_count += 1`
/// (saturating) and `AutoPass { strike: count, forfeit: count ≥ autopass_forfeit }`; wild →
/// `AutoFlee`.
///
/// # Errors
/// `NoWindow` when none is open; `NotDue` when `now_ms < deadline_ms` (a premature fire) — the
/// clock is untouched on `Err`.
pub fn expire(
    clock: &mut ClockState,
    now_ms: i64,
    kind: BattleKind,
    t: &TacticsTuning,
) -> Result<Expiry, ClockError> {
    let deadline_ms = match (clock.window_open_ms, clock.deadline_ms) {
        (Some(_), Some(deadline_ms)) => deadline_ms,
        _ => return Err(ClockError::NoWindow),
    };
    if now_ms < deadline_ms {
        return Err(ClockError::NotDue { deadline_ms });
    }
    clock.window_open_ms = None;
    clock.deadline_ms = None;
    if kind.uses_pvp_rules() {
        clock.autopass_count = clock.autopass_count.saturating_add(1);
        Ok(Expiry::AutoPass {
            strike: clock.autopass_count,
            forfeit: clock.autopass_count >= t.autopass_forfeit,
        })
    } else {
        Ok(Expiry::AutoFlee)
    }
}
