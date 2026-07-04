//! Combat engine — pure, deterministic, integer-only (ADR-0003).
//!
//! All battle resolution lives here exactly once (ADR-0003 SSOT). The server
//! resolves battles authoritatively (ADR-0017); the client does NOT predict
//! battles (client-wasm prediction applies to movement only). Re-implementing a
//! battle rule in another crate is the desync bug.
//!
//! # Module layout
//! - `types`      — value objects (`BattleMonster`, `BattleState`, `BattleEvent`, …)
//! - `type_chart` — `TypeChart` lookup struct
//! - `damage`     — damage formula (`calc_damage`) and accuracy check
//! - `resolve`    — turn resolution (`resolve_turn`, `resolve_enemy_turn`, …)
//! - `ai`         — enemy AI skill picker (`pick_best_skill`)
//! - `xp`         — XP reward and level-up (`battle_xp_reward`, `apply_xp_gain`)

pub mod ai;
pub mod damage;
#[cfg(test)]
pub mod m7b_gating_tests;
#[cfg(test)]
pub mod m7b_redteam_tests;
#[cfg(test)]
pub mod redteam_m8d_tests;
#[cfg(test)]
pub mod redteam_new_findings;
pub mod resolve;
pub mod type_chart;
pub mod types;
pub mod xp;

pub use ai::pick_best_skill;
pub use damage::{accuracy_check, calc_damage};
pub use resolve::{resolve_enemy_turn, resolve_player_swap, resolve_turn};
pub use type_chart::TypeChart;
pub use types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, Effectiveness, SideId,
    TurnChoice, TurnVariance,
};
pub use xp::{apply_xp_gain, base_stat_total, battle_xp_reward, practice_xp_reward};
