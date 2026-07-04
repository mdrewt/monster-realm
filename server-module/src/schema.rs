//! `schema` — server-module domain submodule (M8.9, ADR-0056).
//!
//! The data `#[spacetimedb::table]` structs + their row types. The shared
//! `game-core` type IS the schema (never re-declared); time columns are `i64` ms
//! (round-trip `game_core::Millis`). Tables are additive (ADR-0006); world tables
//! carry an indexed `zone_id` (ADR-0007).
//!
//! Exception (ADR-0056 / spec §6 macro hygiene): the `movement_tick_schedule`
//! scheduled table lives with its `movement_tick` reducer in `movement.rs` so the
//! `scheduled(movement_tick)` reference resolves.
//!
//! Cross-module `ctx.db.<table>()` callers must import the generated snake_case
//! accessor trait (e.g. `use crate::schema::config;`). This file name is part of
//! the canonical `touches:` vocabulary fixed by ADR-0056 — keep it stable.

use game_core::{ActionState, Affinity, BattleState, Direction, MoveInput, NatureKind, StatKind};
use spacetimedb::Identity;

// --- Tables (additive, ADR-0006; world tables carry an indexed zone_id, ADR-0007) ---

/// One renderable entity. The enum/queue columns are the EXACT M1 `game-core`
/// types (the shared type IS the schema, never re-declared). `move_queue` is
/// bounded + public so the owner's client reconciles against the undrained queue.
#[spacetimedb::table(name = character, public)]
pub struct Character {
    #[primary_key]
    #[auto_inc]
    pub entity_id: u64,
    #[index(btree)]
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub facing: Direction,
    pub action: ActionState,
    pub move_started_at_ms: i64,
    pub sprite_id: u32,
    pub move_queue: Vec<MoveInput>,
}

/// Links a connection identity to its character. `last_input_seq` is the
/// reconciliation ack (set at accept-time) — NEVER trusted for authority.
#[spacetimedb::table(name = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub entity_id: u64,
    pub name: String,
    pub online: bool,
    pub last_input_seq: u64,
}

/// Singleton world config.
#[spacetimedb::table(name = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub content_version: u32,
    #[default(Identity::from_byte_array([0u8; 32]))]
    pub owner_identity: Identity,
}

/// Zone definitions seeded from the `game-core` RON registry by `sync_content`.
#[spacetimedb::table(name = zone_def, public)]
pub struct ZoneDefRow {
    #[primary_key]
    pub zone_id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

// --- Content tables (M6b, public, world-readable, module-write-only, ADR-0006) --

/// Species definitions seeded from the `game-core` RON registry by `sync_content`.
#[derive(Clone)]
#[spacetimedb::table(name = species_row, public)]
pub struct SpeciesRow {
    #[primary_key]
    pub id: u32,
    pub name: String,
    pub base_hp: u16,
    pub base_attack: u16,
    pub base_defense: u16,
    pub base_speed: u16,
    pub base_sp_attack: u16,
    pub base_sp_defense: u16,
    pub affinity: Affinity,
    pub learnable_skill_ids: Vec<u32>,
}

/// Skill definitions seeded from the `game-core` RON registry.
#[spacetimedb::table(name = skill_row, public)]
pub struct SkillRow {
    #[primary_key]
    pub id: u32,
    pub name: String,
    pub affinity: Affinity,
    pub power: u16,
    pub accuracy: u8,
    pub pp: u8,
}

/// Type effectiveness chart seeded from the `game-core` RON registry.
#[spacetimedb::table(name = type_relation_row, public)]
pub struct TypeRelationRow {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attacker: Affinity,
    pub defender: Affinity,
    pub effectiveness: u8,
}

/// Item definitions seeded from the `game-core` RON registry.
#[spacetimedb::table(name = item_row, public)]
pub struct ItemRow {
    #[primary_key]
    pub id: u32,
    pub name: String,
    pub description: String,
    /// Per-mille bonus this item grants to `recruit_chance` when used as bait
    /// (0 = not bait). Seeded from the `game-core` `ItemDef` (one SSOT), so both
    /// client and server classify bait by data, never by a hardcoded id.
    pub recruit_bonus: u16,
    /// Focus-training target stat (M9b-tail); None for non-training items.
    /// Seeded 1:1 from `ItemDef.train_stat` (content SSOT).
    pub train_stat: Option<StatKind>,
    /// EVs granted toward `train_stat` per use; 0 for non-training items.
    pub train_amount: u16,
}

// --- Encounter table (M8b, ADR-0040 second visibility mode: must-never-leak) ----

/// Server-local marshaled encounter entry — flatten-at-boundary (`Level` -> `u8`,
/// the same pattern as `Millis` -> `i64`). Lives inside the private `EncounterRow`.
#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct EncounterEntryRow {
    pub species_id: u32,
    pub weight: u16,
    pub min_level: u8,
    pub max_level: u8,
}

/// PRIVATE encounter table (no `public`). Spawn weights/level bands are
/// server-only truth that must NEVER reach any client — there is no public
/// projection and no RLS filter (ADR-0040: the second visibility mode).
#[spacetimedb::table(name = encounter)]
pub struct EncounterRow {
    #[primary_key]
    pub zone_id: u32,
    pub encounter_rate: u16,
    pub entries: Vec<EncounterEntryRow>,
}

// --- Monster tables (M6b, ADR-0015 fallback: split private + public projection) --

/// The authoritative monster record — PRIVATE (no `public`). Contains hidden
/// genes (IVs, EVs, nature) that must NEVER reach a non-owner client. Only
/// server-side reducers read/write this table; no client can subscribe.
#[derive(Clone)]
#[spacetimedb::table(name = monster)]
pub struct Monster {
    #[primary_key]
    #[auto_inc]
    pub monster_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
    pub nickname: String,
    // Progression
    pub level: u8,
    pub xp: u32,
    pub bond: u8,
    // Hidden genes — MUST NEVER reach non-owner clients (ADR-0015)
    pub iv_hp: u8,
    pub iv_attack: u8,
    pub iv_defense: u8,
    pub iv_speed: u8,
    pub iv_sp_attack: u8,
    pub iv_sp_defense: u8,
    pub nature_kind: NatureKind,
    pub ev_hp: u16,
    pub ev_attack: u16,
    pub ev_defense: u16,
    pub ev_speed: u16,
    pub ev_sp_attack: u16,
    pub ev_sp_defense: u16,
    // Derived stats (server-computed via game_core::derive_stats, stored)
    pub stat_hp: u16,
    pub stat_attack: u16,
    pub stat_defense: u16,
    pub stat_speed: u16,
    pub stat_sp_attack: u16,
    pub stat_sp_defense: u16,
    // Combat state (persists between battles)
    pub current_hp: u16,
    // Party slot: 255 = in box (not in party), 0..5 = party position
    pub party_slot: u8,
    // Per-monster care cooldown anchor (M9b, ADR-0059): server clock ms of the
    // last successful `care`. Additive (ADR-0006). New monsters start at 0 (epoch
    // ⇒ cooldown elapsed ⇒ first care allowed). Stays OFF monster_pub (YAGNI).
    pub last_care_at_ms: i64,
    // Evolution eligibility (M10b, ADR-0061): server-computed passive evolves_to.
    // Additive (ADR-0006). Exposed to client subscription for UI hints.
    // None on creation (taming sets None; sync_content, evolve, battle level-up,
    // and care recompute via compute_evolves_to; ADR-0073 §12.5b-4).
    pub evolves_to: Option<u32>,
}

/// Public projection of the monster table — NO hidden fields (no IVs, EVs,
/// nature). Clients subscribe to this for the box/party view. Server writes
/// this alongside every `monster` mutation (dual-write discipline).
#[derive(Clone)]
#[spacetimedb::table(name = monster_pub, public)]
pub struct MonsterPub {
    #[primary_key]
    pub monster_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
    pub nickname: String,
    pub level: u8,
    pub xp: u32,
    pub bond: u8,
    pub current_hp: u16,
    // Derived stats (safe to expose — computed server-side)
    pub stat_hp: u16,
    pub stat_attack: u16,
    pub stat_defense: u16,
    pub stat_speed: u16,
    pub stat_sp_attack: u16,
    pub stat_sp_defense: u16,
    pub party_slot: u8,
    // Evolution eligibility (M10b, ADR-0061): server-computed passive evolves_to.
    // Safe to expose (client never computes it, only reads for UI).
    pub evolves_to: Option<u32>,
}

// --- Battle table (M7b, public, ADR-0042) ------------------------------------

/// A single PvE or PvP battle. The `state` column holds the full `BattleState`
/// (pure data from `game-core`); the server module is the ONLY writer. Public so
/// both participants can subscribe; hidden fields (IVs/EVs) are NOT in
/// `BattleState` — only derived stats appear there (ADR-0015 satisfied).
#[spacetimedb::table(name = battle, public)]
pub struct Battle {
    #[primary_key]
    #[auto_inc]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    pub opponent_identity: Identity,
    pub state: BattleState,
    pub party_monster_ids: Vec<u64>,
    pub opponent_monster_ids: Vec<u64>,
    pub created_at_ms: i64,
}

/// PRIVATE wild-individuality side-table (M8c, ADR-0045). Keyed 1:1 by
/// `battle_id`. Stores the splitmix32 `individuality_seed` that M8d re-feeds to
/// `roll_individuality` to rebuild the EXACT wild that was fought. NO `public`:
/// the raw RNG-derived seed must never reach any client (no projection, no RLS
/// filter, no generated accessor — mirrors the private `encounter` table,
/// ADR-0044). M8c only WRITES this row; M8d reads/clears it.
#[spacetimedb::table(name = battle_wild)]
pub struct BattleWild {
    #[primary_key]
    pub battle_id: u64,
    pub wild_species_id: u32,
    pub wild_level: u8,
    pub individuality_seed: u32,
}

/// Player item inventory (M8d, ADR-0046). PUBLIC / world-readable counts: there
/// is NO transport RLS (no `client_visibility_filter` exists in this toolchain —
/// ADR-0040/0046), so every client can read every owner's counts. Owner-scoping
/// is only a CLIENT subscription filter; per-owner transport RLS is tracked for
/// M16. Carries ONLY ownership + count — NO gene/seed fields; individuality stays
/// in the private `monster` table. Single-stack invariant: at most ONE row per
/// `(owner_identity, item_id)`, enforced by routing every insert through
/// `grant_item` (the `inventory-single-stack` parity eval, ADR-0054) — there is
/// no DB-level composite unique constraint (unsupported in this toolchain).
#[spacetimedb::table(name = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}

/// Fusion recipes (M10b, ADR-0061): public content table seeded from game-core.
/// Each row defines an order-independent recipe `(a, b) → to_species`.
/// Recipes are looked up by canonical pair (min(a,b), max(a,b)) to enforce
/// order-independence — see evolution.rs `find_fusion_recipe`.
#[derive(Clone)]
#[spacetimedb::table(name = fusion, public)]
pub struct Fusion {
    #[primary_key]
    #[auto_inc]
    pub fusion_id: u64,
    pub a_species: u32,
    pub b_species: u32,
    pub to_species: u32,
}

// --- M12b tables: NPC, dialogue, quest, healing (ADR-0069) -------------------

/// NPC entity role row. Entity/component: an NPC is a `character` row + this.
/// `zone_id` mirrors `character.zone_id` (kept in sync on zone crossings, M12c).
#[spacetimedb::table(name = npc, public)]
pub struct Npc {
    #[primary_key]
    pub entity_id: u64,
    #[unique]
    pub npc_id: String,
    #[index(btree)]
    pub zone_id: u32,
    pub home_x: i32,
    pub home_y: i32,
    pub wander_radius: u8,
    pub dialogue_tree_id: String,
}

/// PRIVATE per-player dialogue state: flags + done-quest history.
/// Must-never-leak: flags gate content branches (ADR-0015, ADR-0069).
/// `active_quests` is NOT stored here — derived from `player_quest` rows.
#[spacetimedb::table(name = player_dialogue_state)]
pub struct PlayerDialogueStateRow {
    #[primary_key]
    pub owner_identity: Identity,
    pub flags: Vec<String>,
    pub done_quests: Vec<String>,
}

/// Active quest progress. Public (quest log is world-readable like `inventory`).
/// Per-owner transport RLS deferred to M16.
#[derive(Clone)]
#[spacetimedb::table(name = player_quest, public)]
pub struct PlayerQuestRow {
    #[primary_key]
    #[auto_inc]
    pub pq_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub quest_id: String,
    pub step_index: u32,
}

/// In-progress dialogue node. Single row per player (PK = owner_identity).
#[spacetimedb::table(name = player_conversation, public)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}

/// Healing location content seeded by `sync_content`. Public (world-readable).
#[spacetimedb::table(name = heal_location_row, public)]
pub struct HealLocationRow {
    #[primary_key]
    pub location_id: u32,
    #[index(btree)]
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub cost_item_id: Option<u32>,
    pub cost_qty: u32,
    pub cooldown_ms: i64,
}

/// PRIVATE per-player heal cooldown anchor.
/// Must-never-leak: timestamp reveals heal timing (ADR-0015, ADR-0069).
#[spacetimedb::table(name = heal_cooldown)]
pub struct HealCooldown {
    #[primary_key]
    pub owner_identity: Identity,
    pub last_heal_at_ms: i64,
}

// --- M13a currency table (ADR-0081) ------------------------------------------

/// PRIVATE per-player wallet — one row per player (PK = owner_identity).
/// Balance is MUST-NEVER-LEAK: no `public`, no projection, no RLS filter
/// (ADR-0015/ADR-0081). The single-surface discipline (ADR-0081) requires all
/// balance mutations to route through `economy::grant_currency` /
/// `economy::spend_currency` → `game_core::currency::apply_grant` /
/// `game_core::currency::apply_spend`.
///
/// STUB: this table declaration is additive (ADR-0006). The implementer must
/// leave it WITHOUT the `public` attribute (privacy invariant test bites if
/// `public` is added).
#[spacetimedb::table(name = player_wallet)]
pub struct PlayerWallet {
    #[primary_key]
    pub owner_identity: Identity,
    pub balance: u64,
}
