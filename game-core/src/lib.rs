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
pub mod currency;
pub mod dialogue;
pub mod evolution;
pub mod monster;
pub mod npc;
pub mod quest;
pub mod raising;
pub mod taming;
pub mod types;
pub mod world;

#[cfg(test)]
mod m8c_gating_tests;

pub use combat::{
    accuracy_check, apply_post_turn_effects, apply_pre_turn_effects, apply_xp_gain,
    base_stat_total, battle_xp_reward, calc_damage, pick_best_skill, practice_xp_reward,
    resolve_enemy_turn, resolve_full_turn, resolve_player_swap, resolve_turn, tick_status,
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, BattleStatusStore,
    Effectiveness, SideId, StatusEffect, StatusVariance, TurnChoice, TurnVariance, TypeChart,
};
pub use content::{
    load_dialogue_trees, load_encounters, load_evolutions, load_fusion, load_heal_locations,
    load_items, load_npc_defs, load_quest_defs, load_shops, load_skills, load_species,
    load_type_chart, load_zone_maps, load_zones, parse_dialogue_trees, parse_dialogue_trees_parts,
    parse_encounters, parse_evolutions, parse_fusion, parse_heal_locations,
    parse_heal_locations_parts, parse_items, parse_npc_defs, parse_npc_defs_parts,
    parse_quest_defs, parse_quest_defs_parts, parse_shops, parse_skills, parse_species,
    parse_type_chart, parse_zone_maps, parse_zone_maps_parts, parse_zones, validate_content,
    validate_encounters, validate_evolution_fusion, validate_npc_content, validate_shops,
    validate_zones, EvolutionCondition, EvolutionTrigger, FusionRecipe, HealLocationDef, ItemDef,
    NpcDef, ShopDef, ShopStockEntry, SkillDef, Species, SpeciesEvolutions, TypeRelation, WarpDef,
    ZoneDef, ZoneMapDef,
};
pub use currency::battle_currency_reward;
pub use dialogue::{
    apply_choice, apply_effects, apply_node_auto_effects, available_choices, evaluate_condition,
    find_entry_node, Condition, DialogueChoice, DialogueEffect, DialogueError, DialogueNode,
    DialogueTree, PlayerDialogueState,
};
pub use evolution::{evolve, evolves_to, fuse, resolve_evolution};
pub use monster::{
    build_monster, derive_stats, level_bounds, level_for_xp, roll_individuality, roll_starter,
    xp_for_level, Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock,
    StatKind, Xp,
};
pub use npc::npc_decide;
pub use quest::{
    can_start_quest, process_trigger, trigger_matches, PlayerQuestProgress, QuestAdvance, QuestDef,
    QuestReward, QuestStep, RewardItem, StepTrigger, TriggerEvent,
};
pub use raising::{apply_care, focus_train, CareError, FocusTrainError, FocusTrainResult};
pub use taming::{
    attempt_recruit, encounter_triggers, recruit_chance, resolve_encounter, roll_encounter,
    EncounterEntry, EncounterTable, WildSpawn, MISSING_HP_FACTOR, RECRUIT_BASE_RATE,
};
pub use types::{ActionState, CharacterState, Direction, Millis, MoveInput, TileKind, TilePos};
pub use world::{
    apply_move, apply_move_coded, check_party_slot, map_for, spawn, stepped_onto_grass,
    validate_zone_maps, zone_0, SlotError, TileMap, MOVE_QUEUE_CAP, PARTY_SIZE, PARTY_SLOT_NONE,
    STEP_MS,
};

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

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: known-answer vectors pin the exact
    // splitmix64 finalizer of `tick_seed`. Any XOR/shift mutation
    // (`^`->`|`, `^`->`&`, `>>`->`<<`) alters every vector below.
    // Determinism contract: ADR-0003 (same seed -> same result, forever).
    // -----------------------------------------------------------------------

    /// Kills: all bit-mixing mutants in `tick_seed` (9 nightly survivors).
    /// Vectors computed with an independent Python splitmix64 replica;
    /// `tick_seed(0,0,0)` equals the canonical first splitmix64(0) output.
    #[test]
    fn tick_seed_known_answer_vectors() {
        assert_eq!(tick_seed(0, 0, 0), 0xE220_A839_7B1D_CDAF);
        assert_eq!(tick_seed(1, 2, 3), 0xBD64_A5D9_ADEF_E000);
        assert_eq!(
            tick_seed(0xDEAD_BEEF, 0x1234_5678, 0x9ABC_DEF0),
            0x3FDF_67C5_BA9F_477A
        );
        assert_eq!(
            tick_seed(u64::MAX, u64::MAX, u64::MAX),
            0xF75F_04CB_B5A1_A1DD
        );
    }
}
