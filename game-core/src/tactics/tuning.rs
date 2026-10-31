//! `TacticsTuning` — every constant of the M-battle-tactics design (§2.1, §2.1.2, §2.3, §2.4,
//! §3.7, §6.4) in one struct, read by every tactics rule — and `BattleKind`, the ruleset selector.
//!
//! bt-6 loads `game-core/content/tactics_tuning.ron` into this struct; until then (and in every
//! test) [`TacticsTuning::DESIGN`] carries the design's numbers. A rule never hard-codes one of
//! these values: `economy`, `resolve` and `upkeep` take `&TacticsTuning` and read the field, so
//! a retune is a content edit, not a code edit. `deny_unknown_fields` makes a misspelt RON key a
//! load error instead of a silently ignored constant, and [`TacticsTuning::validate`] rejects a
//! zero denominator before any rule can divide by it. There is deliberately no `Default`: a
//! caller must name `DESIGN` or load content, never fall back silently.

use serde::{Deserialize, Serialize};

/// Battle kind (stored in `battle_tactical.kind`). Wild = PvE. Pvp and Practice share the PvP
/// ruleset (Surge, adjudication, no Recruit/Flee; Practice has no rating or rewards) — the ONE
/// place that mapping lives is [`BattleKind::uses_pvp_rules`]. Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum BattleKind {
    Wild,
    Pvp,
    Practice,
}

impl BattleKind {
    /// Pvp and Practice (design §6.1: Practice uses the PvP ruleset). Wild never.
    #[must_use]
    pub fn uses_pvp_rules(self) -> bool {
        todo!("bt-2 tuning: BattleKind::uses_pvp_rules")
    }
}

/// The design constants (values: design §2.1 table, §2.1.2 Guard, §2.3 clock, §2.4 flank,
/// §3.7 wild bounds, §6.4 Surge). Integers only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TacticsTuning {
    /// AP refreshed at every unit-turn start; no carry-over.
    pub ap_turn: u8,
    /// AP per stride of a Move entry.
    pub move_stride_cost: u8,
    /// Strides per unit-turn across all Move entries.
    pub max_strides_per_turn: u8,
    /// Added once to a Move entry starting adjacent to a living enemy (Fly exempt).
    pub disengage_tax: u8,
    /// AP of a Light skill.
    pub light_cost: u8,
    /// AP of a Heavy skill.
    pub heavy_cost: u8,
    /// Exert: added to the second and every later attack of a unit-turn.
    pub exert_surcharge: u8,
    /// AP of an Item entry.
    pub item_cost: u8,
    /// AP of Recruit (the whole budget, so it is the only entry).
    pub recruit_cost: u8,
    /// AP of Flee (wild only; the whole budget).
    pub flee_cost: u8,
    /// AP of the terminal EndTurn entry.
    pub end_turn_cost: u8,
    /// Guard needs at least this many AP unspent at a committed turn end.
    pub guard_min_ap: u8,
    /// Guard multiplies incoming attack damage by `guard_num / guard_den` (floor, min 1).
    pub guard_num: u8,
    /// Denominator of the Guard multiplier (never 0: `validate`).
    pub guard_den: u8,
    /// Flank multiplies attack damage by `flank_num / flank_den` (floor).
    pub flank_num: u8,
    /// Denominator of the flank multiplier (never 0: `validate`).
    pub flank_den: u8,
    /// First round whose upkeep deals Surge (PvP ruleset only).
    pub surge_start_round: u16,
    /// Surge per round: `max_hp × pct × (round + 1 − surge_start_round) / 100`.
    pub surge_pct_per_round: u8,
    /// Wild battles auto-flee at the end of this round.
    pub wild_round_cap: u16,
    /// PvP idle window per `Waiting(U)` entry.
    pub pvp_window_ms: u32,
    /// PvE idle window per `Waiting(U)` entry.
    pub pve_window_ms: u32,
    /// PvP deploy clock.
    pub pvp_deploy_ms: u32,
    /// PvE deploy clock (pack ≥ 2 confirm screen).
    pub pve_deploy_ms: u32,
    /// Windows per unit-turn (6 → 4 → 2 AP).
    pub max_windows_per_turn: u8,
    /// The n-th PvP auto-pass of a match forfeits it.
    pub autopass_forfeit: u8,
    /// Cap on the presentation pad added before a window opens.
    pub pad_cap_ms: u32,
}

/// A tuning value no rule can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TuningError {
    /// `guard_den == 0`.
    ZeroGuardDen,
    /// `flank_den == 0`.
    ZeroFlankDen,
    /// `ap_turn == 0`: no entry could ever be spent.
    ZeroApTurn,
}

impl TacticsTuning {
    /// The design's numbers (bt-6's `tactics_tuning.ron` must equal this value).
    pub const DESIGN: TacticsTuning = TacticsTuning {
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
    };

    /// Reject a tuning no rule can run on (checked in [`TuningError`] declaration order).
    ///
    /// # Errors
    /// See [`TuningError`].
    pub fn validate(&self) -> Result<(), TuningError> {
        todo!("bt-2 tuning: TacticsTuning::validate")
    }
}
