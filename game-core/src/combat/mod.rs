//! Combat engine — pure, deterministic, integer-only.
//!
//! All battle resolution lives here exactly once (ADR-0003 SSOT). The server
//! resolves battles authoritatively; the client does NOT predict
//! battles (client-wasm prediction applies to movement only). Re-implementing a
//! battle rule in another crate is the desync bug.
//!
//! # Module layout
//! - `types`      — value objects (`BattleMonster`, `BattleState`, `BattleEvent`, …)
//! - `type_chart` — `TypeChart` lookup struct
//! - `damage`     — damage formula (`calc_damage`) and accuracy check
//! - `resolve`    — turn resolution (`resolve_turn`, `resolve_full_turn`, `resolve_enemy_turn`, …)
//! - `status`     — per-monster status conditions, DoT, action-block rules (ADR-0010 OCP gate)
//! - `ability`    — passive per-species ability rules
//! - `ai`         — enemy AI skill picker (`pick_best_skill`)
//! - `xp`         — XP reward, practice penalty, and level-up (`battle_xp_reward`, `practice_xp_reward`, `apply_xp_gain`)
//! - `pvp`        — pure PvP orchestration rules: `PvpAction`, forfeit/deadline logic

pub mod ability;
#[cfg(test)]
pub mod ability_tests;
pub mod ai;
#[cfg(test)]
pub mod battle_0hp_tests;
#[cfg(test)]
pub mod battle_core_tests;
pub mod damage;
pub mod pvp;
pub mod resolve;
pub mod status;
#[cfg(test)]
pub mod status_tests;
pub mod type_chart;
pub mod types;
pub mod weather;
#[cfg(test)]
pub mod weather_tests;
pub mod xp;

pub use ability::{
    apply_ability_modifiers, apply_entry_ability, AbilityEffect, AbilityStore, StatusKind,
};
pub use ai::pick_best_skill;
pub use damage::{accuracy_check, calc_damage};
pub use pvp::{
    is_challenge_stale, pvp_deadline_forfeit_side, pvp_forfeit_outcome, PvpAction, CHALLENGE_TTL_MS,
};
pub use resolve::{resolve_enemy_turn, resolve_full_turn, resolve_player_swap, resolve_turn};
pub use status::{
    apply_post_turn_effects, apply_pre_turn_effects, tick_status, BattleStatusStore, StatusVariance,
};
pub use type_chart::TypeChart;
pub use types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, Effectiveness, SideId,
    StatusEffect, TurnChoice, TurnVariance,
};
pub use weather::{WeatherEffect, WeatherKind};
pub use xp::{apply_xp_gain, base_stat_total, battle_xp_reward, practice_xp_reward};
