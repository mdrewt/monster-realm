//! monster-realm `game-core` — the single, pure, deterministic rule layer.
//!
//! Every game rule lives here exactly once (ADR-0003, SSOT). The server runs it
//! for truth; the client runs the *same compiled code* (via `client-wasm`) for
//! prediction. Re-implementing a rule elsewhere is the desync bug.
//!
//! Purity is mechanically enforced: `clippy.toml` (`disallowed-methods`) bans
//! wall-clock reads and unseeded RNG workspace-wide. Time and randomness are
//! *injected*: the server passes `ctx.timestamp` as `Millis`, tests seed an
//! explicit RNG, and `sim-harness` drives a deterministic clock + seed.

#![forbid(unsafe_code)]

pub mod combat;
pub mod content;
pub mod monster;
pub mod taming;
pub mod types;
pub mod world;

pub use combat::{
    accuracy_check, apply_xp_gain, battle_xp_reward, calc_damage, pick_best_skill,
    resolve_enemy_turn, resolve_player_swap, resolve_turn, BattleEvent, BattleMonster,
    BattleOutcome, BattleSide, BattleState, Effectiveness, SideId, TurnChoice, TurnVariance,
    TypeChart,
};
pub use content::{
    load_encounters, load_items, load_skills, load_species, load_type_chart, load_zones,
    parse_encounters, parse_items, parse_skills, parse_species, parse_type_chart, parse_zones,
    validate_content, validate_encounters, validate_zones, ItemDef, SkillDef, Species,
    TypeRelation, ZoneDef,
};
pub use monster::{
    derive_stats, level_bounds, level_for_xp, roll_individuality, roll_starter, xp_for_level,
    Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, StatKind, Xp,
};
pub use taming::{
    attempt_recruit, encounter_triggers, recruit_chance, roll_encounter, EncounterEntry,
    EncounterTable, MISSING_HP_FACTOR,
};
pub use types::{ActionState, CharacterState, Direction, Millis, MoveInput, TileKind, TilePos};
pub use world::{apply_move, apply_move_coded, spawn, zone_0, TileMap, MOVE_QUEUE_CAP, STEP_MS};

/// The trivial M0 proof-rule: a pure, deterministic state transition over an
/// explicit seed (splitmix64-style mix). It proves the determinism/parity gates
/// have teeth. Identical `(state, input, seed)` returns byte-identical output on
/// every target (native server path and the wasm client path).
#[must_use]
pub fn tick_seed(state: u64, input: u64, seed: u64) -> u64 {
    let mut z = state
        .wrapping_add(input)
        .wrapping_add(seed)
        .wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Pure movement helper: clamp a coordinate into `[-max, max]`.
#[must_use]
pub fn clamp_position(v: i32, max: i32) -> i32 {
    v.clamp(-max, max)
}

#[cfg(test)]
mod tests {
    use super::{clamp_position, tick_seed};

    #[test]
    fn tick_seed_is_referentially_deterministic() {
        assert_eq!(tick_seed(1, 2, 3), tick_seed(1, 2, 3));
    }

    #[test]
    fn tick_seed_replay_is_byte_identical() {
        let trace_a: Vec<u64> = (0..1000)
            .map(|i| tick_seed(i, i.wrapping_mul(7), i ^ 0xDEAD))
            .collect();
        let trace_b: Vec<u64> = (0..1000)
            .map(|i| tick_seed(i, i.wrapping_mul(7), i ^ 0xDEAD))
            .collect();
        assert_eq!(trace_a, trace_b);
    }

    #[test]
    fn tick_seed_depends_on_seed() {
        assert_ne!(tick_seed(1, 2, 3), tick_seed(1, 2, 4));
    }

    #[test]
    fn clamp_position_bounds() {
        assert_eq!(clamp_position(1500, 1000), 1000);
        assert_eq!(clamp_position(-1500, 1000), -1000);
        assert_eq!(clamp_position(42, 1000), 42);
    }
}
