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

use game_core::{
    ActionState, Affinity, BattleState, Direction, MoveInput, NatureKind, NpcInteraction, StatKind,
    StatusKind, TrustTier,
};
use spacetimedb::Identity;

// --- Tables (additive, ADR-0006; world tables carry an indexed zone_id, ADR-0007) ---

/// One renderable entity. The enum/queue columns are the EXACT M1 `game-core`
/// types (the shared type IS the schema, never re-declared). `move_queue` is
/// bounded + public so the owner's client reconciles against the undrained queue.
#[spacetimedb::table(accessor = character, public)]
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
#[spacetimedb::table(accessor = player, public)]
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
#[spacetimedb::table(accessor = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub content_version: u32,
    #[default(Identity::from_byte_array([0u8; 32]))]
    pub owner_identity: Identity,
}

/// Zone definitions seeded from the `game-core` RON registry by `sync_content`.
#[spacetimedb::table(accessor = zone_def, public)]
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
#[spacetimedb::table(accessor = species_row, public)]
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
    pub ability: Option<u32>, // additive (ADR-0006); None = no passive ability
    // Evolution-graph tier (EG1-3, ADR-0174 D1): 0 = a base, wild-catchable
    // form; every evolution edge advances exactly +1 (R5). Tail-appended with an
    // explicit default (ADR-0173 D5).
    #[default(0)]
    pub tier: u8,
}

/// Skill definitions seeded from the `game-core` RON registry.
#[spacetimedb::table(accessor = skill_row, public)]
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
#[spacetimedb::table(accessor = type_relation_row, public)]
pub struct TypeRelationRow {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attacker: Affinity,
    pub defender: Affinity,
    pub effectiveness: u8,
}

/// Item definitions seeded from the `game-core` RON registry.
#[spacetimedb::table(accessor = item_row, public)]
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
    /// Currency the player receives when selling this item (M13b, ADR-0082).
    /// 0 = item cannot be sold (`sell` reducer rejects). Seeded 1:1 from
    /// `ItemDef.sell_price` (content SSOT).
    pub sell_price: u64,
    /// Status condition this item cures when used in battle via `use_battle_item`
    /// (M14e, ADR-0096; exposed to clients here per M14.5d-1a, ADR-0105).
    /// None for non-cure items. Seeded 1:1 from `ItemDef.cure_status` (content
    /// SSOT) so the client classifies cure items by data, not by hardcoded id
    /// (additive, ADR-0006).
    pub cure_status: Option<StatusKind>,
}

// --- Shop tables (M13b, ADR-0082): public content, world-readable ---

/// Shop definitions seeded from the `game-core` RON registry.
/// Public (world-readable content, like `item_row` — shop names are not private).
#[spacetimedb::table(accessor = shop_row, public)]
pub struct ShopRow {
    #[primary_key]
    pub shop_id: u32,
    pub name: String,
}

/// Shop stock entries seeded from the `game-core` RON registry.
/// One row per (shop, item) pair. Looked up by shop_id index in the `buy` reducer.
/// Public (world-readable — shop prices are game content, not sensitive).
#[spacetimedb::table(accessor = shop_item_row, public)]
pub struct ShopItemRow {
    #[primary_key]
    #[auto_inc]
    pub shop_item_id: u64,
    #[index(btree)]
    pub shop_id: u32,
    pub item_id: u32,
    /// Currency cost to buy one unit of this item from this shop.
    pub buy_price: u64,
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
#[spacetimedb::table(accessor = encounter)]
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
#[spacetimedb::table(accessor = monster)]
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
    // (`bond` and `evolves_to` were removed here by Migration B — EG5-6, ADR-0177 D2.
    // A column removal is always rejected by automatic migration; a live DB on the
    // Migration-A schema needs the ADR-0177 runbook, never a plain republish.)
    // --- EG1 Migration A: 16 appended columns (ADR-0174 D1). APPEND-AT-END ONLY:
    // live spacetime 2.6.0 accepts an automatic migration only as tail-appended
    // columns each carrying an explicit default (ADR-0173 D5); a mid-struct
    // insert is a live-DB migration rejection. Trust and Quality-Time SEMANTICS
    // (who writes these, when) land in EG2 — EG1 only freezes the storage.
    // Per-Affinity essence pools, in Affinity declaration order (Fire..Dark) —
    // the same order as Affinity::ALL and MonsterInstance.essence (EG1-1/EG1-7).
    #[default(0)]
    pub essence_fire: u32,
    #[default(0)]
    pub essence_water: u32,
    #[default(0)]
    pub essence_plant: u32,
    #[default(0)]
    pub essence_electric: u32,
    #[default(0)]
    pub essence_earth: u32,
    #[default(0)]
    pub essence_wind: u32,
    #[default(0)]
    pub essence_light: u32,
    #[default(0)]
    pub essence_dark: u32,
    // Lifetime Trust event counters (EG1-1; tiering via game_core::trust_tier_of).
    #[default(0)]
    pub trust_favorable_count: u32,
    #[default(0)]
    pub trust_unfavorable_count: u32,
    // Server-only Trust bookkeeping: day-epoch anchor for the once-per-24h
    // favorable battle credit (EG2 writes it; 0 = never credited).
    #[default(0)]
    pub trust_favorable_battle_day_epoch: u32,
    // Lifetime Quality-Time ticks (EG1-1; tiering via quality_time_tier_of).
    #[default(0)]
    pub quality_time_ticks_total: u32,
    // Server-only Quality-Time accumulators (EG2 semantics; 0 = empty window).
    #[default(0)]
    pub quality_time_accum_ms: u32,
    #[default(0)]
    pub quality_time_window_ms: u32,
    // NOTE: the two i64 columns carry a TYPED 0i64 literal — an untyped 0 in
    // #[default(..)] BSATN-encodes as 4 bytes and the publish rejects with
    // "data too short for i64" (measured on live spacetime, EG1).
    #[default(0i64)]
    pub quality_time_window_start_ms: i64,
    // Essence-training cooldown anchor, server clock ms (EG2 writes it; 0 =
    // epoch, cooldown elapsed, first train allowed — mirrors last_care_at_ms).
    #[default(0i64)]
    pub last_essence_train_at_ms: i64,
}

/// Safe projection of the monster table — NO hidden fields (no IVs, EVs,
/// nature). PRIVATE since issue #284 / ADR-0194 (need-to-know): clients read
/// ONLY their OWN rows through the owner-scoped `my_monster_pub` view below;
/// other players' rows are never delivered. Server writes this alongside every
/// `monster` mutation (dual-write discipline, unchanged — visibility is
/// transport-only, server reads/writes are unaffected).
#[derive(Clone)]
#[spacetimedb::table(accessor = monster_pub)]
pub struct MonsterPub {
    #[primary_key]
    pub monster_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
    pub nickname: String,
    pub level: u8,
    pub xp: u32,
    pub current_hp: u16,
    // Derived stats (safe to expose — computed server-side)
    pub stat_hp: u16,
    pub stat_attack: u16,
    pub stat_defense: u16,
    pub stat_speed: u16,
    pub stat_sp_attack: u16,
    pub stat_sp_defense: u16,
    pub party_slot: u8,
    // (`bond` and `evolves_to` were removed here by Migration B — EG5-6, ADR-0177 D2.)
    // --- EG1 Migration A: 12 appended public columns (ADR-0174 D1). APPEND-AT-
    // END ONLY with explicit defaults (ADR-0173 D5). The EG4 client requirements
    // panel reads these — all are derived server-side, never client-written.
    // Evolution-graph tier of this monster's species (EG1-8): written fresh at
    // creation/evolve/sync from the species row, copied forward elsewhere.
    #[default(0)]
    pub tier: u8,
    // Public copies of the 8 essence pools (Affinity declaration order).
    #[default(0)]
    pub essence_fire: u32,
    #[default(0)]
    pub essence_water: u32,
    #[default(0)]
    pub essence_plant: u32,
    #[default(0)]
    pub essence_electric: u32,
    #[default(0)]
    pub essence_earth: u32,
    #[default(0)]
    pub essence_wind: u32,
    #[default(0)]
    pub essence_light: u32,
    #[default(0)]
    pub essence_dark: u32,
    // Derived Trust tier (ADR-0174 D4): with K=10 smoothing, zero history is
    // exactly 0.5 — the 5-band midpoint — so Neutral is the correct default.
    #[default(TrustTier::Neutral)]
    pub trust_tier: TrustTier,
    // Derived Quality-Time tier (ADR-0174 D6 bands).
    #[default(0)]
    pub quality_time_tier: u8,
    // Derived Nutrition percentage of the 510 EV budget (ADR-0174 D3).
    #[default(0)]
    pub nutrition_pct: u8,
}

/// Owner-scoped read path for `monster_pub` (ADR-0194, issue #284): each
/// client's subscription sees ONLY its own rows, via the `owner_identity`
/// btree index — a point index scan, never a table scan. First multi-row
/// (`Vec`) view in the module: the return type no longer bounds the result
/// set (ADR-0154 D3's concern), so THIS BODY is the entire security boundary
/// and is pinned exactly — by `evals/monster-privacy.eval.mjs` and the
/// `e13r_e` mirror in `evolution_tests.rs` — signature included (a 1.12.0
/// view accepts extra args; an extra `owner` param is a caller-chosen-owner
/// leak). Lives next to the table it projects (visibility is a schema
/// artifact — the `my_conversation`/`my_wallet`/`my_account` convention).
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db
        .monster_pub()
        .owner_identity()
        .filter(ctx.sender())
        .collect()
}

// --- Battle table (M7b, ADR-0042; private since 15r-sec-a, ADR-0198) ----------

/// A single PvE or PvP battle. The `state` column holds the full `BattleState`
/// (pure data from `game-core`); the server module is the ONLY writer. PRIVATE
/// since 15r-sec-a (ADR-0198): a public battle table delivered every live
/// battle's both-side derived stats, HP, skills and status to every connected
/// client (the exposure ADR-0042:30 flagged before M16 reused the schema).
/// Participants read ONLY their own rows through the `my_battle` view below.
/// Hidden fields (IVs/EVs) are NOT in `BattleState` — only derived stats appear
/// there (ADR-0015 satisfied) — so the view leaks nothing hidden to the two
/// players who are already in the fight.
///
/// `opponent_identity` gains a btree index in M16a (ADR-0109) to support O(log n)
/// lookup in `forfeit_on_disconnect` for the case where the disconnecting player is
/// the opponent (side B).  Adding an index is additive (ADR-0006): no column or PK
/// change; the schema-snapshot eval tracks columns+PK only, not index presence.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle)]
pub struct Battle {
    #[primary_key]
    #[auto_inc]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    #[index(btree)]
    pub opponent_identity: Identity,
    pub state: BattleState,
    pub party_monster_ids: Vec<u64>,
    pub opponent_monster_ids: Vec<u64>,
    pub created_at_ms: i64,
}

/// Participant-scoped read path for `battle` (ADR-0198): each client's
/// subscription sees ONLY rows where it holds `player_identity` OR
/// `opponent_identity` — a chain of two point index scans over the btree
/// indexes above, never a table scan. Like `my_monster_pub`, THIS BODY is the
/// entire security boundary and is pinned exactly — by
/// `evals/monster-privacy.eval.mjs` and the `e15r_sec_a` mirror in
/// `evolution_tests.rs` — signature included (an extra param is a
/// caller-chosen-owner leak). The trailing filter is DEDUP BY CONSTRUCTION,
/// not an invariant: it excludes the rows the first scan already emitted, so a
/// practice battle (`player_identity == opponent_identity`, battle.rs) arrives
/// exactly once. Rewriting it as `b.player_identity != b.opponent_identity`
/// would delete every practice battle from its own player's view.
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db
        .battle()
        .player_identity()
        .filter(ctx.sender())
        .chain(
            ctx.db
                .battle()
                .opponent_identity()
                .filter(ctx.sender())
                .filter(|b| b.player_identity != ctx.sender()),
        )
        .collect()
}

/// PRIVATE wild-individuality side-table (M8c, ADR-0045). Keyed 1:1 by
/// `battle_id`. Stores the splitmix32 `individuality_seed` that M8d re-feeds to
/// `roll_individuality` to rebuild the EXACT wild that was fought. NO `public`:
/// the raw RNG-derived seed must never reach any client (no projection, no RLS
/// filter, no generated accessor — mirrors the private `encounter` table,
/// ADR-0044). M8c only WRITES this row; M8d reads/clears it.
#[spacetimedb::table(accessor = battle_wild)]
pub struct BattleWild {
    #[primary_key]
    pub battle_id: u64,
    pub wild_species_id: u32,
    pub wild_level: u8,
    pub individuality_seed: u32,
}

/// Player item inventory (M8d, ADR-0046). PUBLIC / world-readable counts:
/// transport RLS is unavailable — `client_visibility_filter` exists in the
/// spacetimedb crate only behind `feature = "unstable"`, and its `Filter::Sql`
/// form cannot express per-id membership in a `Vec<u64>` column (ADR-0194
/// corrects ADR-0040/0046's "does not exist" wording) — so every client can
/// read every owner's counts. Owner-scoping is only a CLIENT subscription
/// filter; per-owner transport scoping would follow the owner-view pattern
/// (`my_monster_pub`, ADR-0194) if inventory is ever reclassified. Carries ONLY ownership + count — NO gene/seed
/// fields; individuality stays
/// in the private `monster` table. Single-stack invariant: at most ONE row per
/// `(owner_identity, item_id)`, enforced by routing every insert through
/// `grant_item` (the `inventory-single-stack` parity eval, ADR-0054) — there is
/// no DB-level composite unique constraint (unsupported in this toolchain).
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}

// (The `Fusion` recipe table — M10b, ADR-0061 — was removed here by Migration B,
// EG5-6/ADR-0177 D2. Fusion was deleted as a feature at EG1-9; the table struct
// survived only because a table removal cannot ride along with Migration A's
// additive publish. Table removal is always rejected by automatic migration —
// a live DB on the Migration-A schema needs the ADR-0177 runbook.)

// --- EG1 evolution-graph tables (ADR-0174 D1) ---------------------------------

/// One per-Affinity essence requirement on an evolution edge (EG1-4). Nested
/// SpacetimeType, mirroring the EncounterEntryRow precedent above. The field
/// set is FROZEN at publish (ADR-0174 D8: live automigration rejects nested-
/// type widening) and Vec semantics are AND-only — every entry must be met.
#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct EssenceRequirementRow {
    pub affinity: Affinity,
    pub amount: u32,
}

/// PUBLIC evolution-graph edge table (EG1-4), seeded clear-and-reinsert from
/// the game-core evolution_paths registry by sync_content. Clients subscribe to
/// it for the requirements panel (EG4); the evolve reducer reads it for the
/// targeted gate lookup.
///
/// IDENTITY (EG1-12): path_id is DB-internal ONLY — an auto_inc value reminted
/// on every reseed, NEVER durable identity. edge_id is THE durable, author-
/// assigned, append-only edge identity.
///
/// INDEX (ADR-0174 D5): this toolchain has no composite unique constraint, so
/// from_species carries a plain btree index for the evolve reducer lookup and
/// R1 — no duplicate (from, to) pair — has NO DB-level backstop; it is enforced
/// by validate_evolution_paths at the content gate plus the sync_content
/// duplicate-pair seed check.
#[spacetimedb::table(accessor = evolution_path, public)]
pub struct EvolutionPathRow {
    #[primary_key]
    #[auto_inc]
    pub path_id: u64,
    pub edge_id: u32,
    #[index(btree)]
    pub from_species: u32,
    pub to_species: u32,
    pub min_level: u8,
    pub essence: Vec<EssenceRequirementRow>,
    pub min_trust_tier: Option<TrustTier>,
    pub min_quality_time_tier: Option<u8>,
    pub min_nutrition_pct: Option<u8>,
}

// --- M12b tables: NPC, dialogue, quest, healing (ADR-0069) -------------------

/// NPC entity role row. Entity/component: an NPC is a `character` row + this.
/// `zone_id` mirrors `character.zone_id` (kept in sync on zone crossings, M12c).
#[spacetimedb::table(accessor = npc, public)]
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
    /// Interaction role (uxd2, ADR-0161): appended LAST (BSATN tail-append —
    /// widening a public row is wire-safe only at the tail). Threaded from
    /// `NpcDef.interaction` by `npc_row_from_def`.
    pub interaction: NpcInteraction,
}

/// PRIVATE per-player dialogue state: flags + done-quest history.
/// Must-never-leak: flags gate content branches (ADR-0015, ADR-0069).
/// `active_quests` is NOT stored here — derived from `player_quest` rows.
#[spacetimedb::table(accessor = player_dialogue_state)]
pub struct PlayerDialogueStateRow {
    #[primary_key]
    pub owner_identity: Identity,
    pub flags: Vec<String>,
    pub done_quests: Vec<String>,
}

/// Active quest progress. Public (quest log is world-readable like `inventory`).
/// Per-owner transport RLS deferred until per-row RLS lands.
#[derive(Clone)]
#[spacetimedb::table(accessor = player_quest, public)]
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
/// PRIVATE since M13.5c (ADR-0087): `npc_entity_id` + `current_node_id` leak
/// private quest/dialogue progress — clients read ONLY through the owner-scoped
/// `my_conversation` view below.
#[spacetimedb::table(accessor = player_conversation)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}

/// Owner-scoped read path for `player_conversation` (ADR-0087): each client's
/// subscription sees ONLY its own row, via the `owner_identity` unique index —
/// never a whole-table scan. Lives next to the table it projects (visibility is
/// a schema artifact, like `monster`/`monster_pub`).
#[spacetimedb::view(accessor = my_conversation, public)]
fn my_conversation(ctx: &spacetimedb::ViewContext) -> Option<PlayerConversation> {
    ctx.db
        .player_conversation()
        .owner_identity()
        .find(ctx.sender())
}

/// Healing location content seeded by `sync_content`. Public (world-readable).
#[spacetimedb::table(accessor = heal_location_row, public)]
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
    /// Currency cost charged by `heal_party` (ADR-0083), mirrored to the client so
    /// the heal UI can display it (12r-d, closes ADR-0170 residual 1). Appended at
    /// the end with a typed default per ADR-0173 D5 — bare `0` BSATN-encodes as
    /// 4 bytes and fails the automigration publish.
    #[default(0u64)]
    pub cost_currency: u64,
}

/// PRIVATE per-player heal cooldown anchor.
/// Must-never-leak: timestamp reveals heal timing (ADR-0015, ADR-0069).
#[spacetimedb::table(accessor = heal_cooldown)]
pub struct HealCooldown {
    #[primary_key]
    pub owner_identity: Identity,
    pub last_heal_at_ms: i64,
}

// --- M15a trade tables (ADR-0106) --------------------------------------------

/// An active trade offer between two players (M15, ADR-0106).
///
/// PUBLIC so both parties can subscribe and see the offer. The display data
/// (`initiator_cards` / `counterparty_cards`) contains only the public-projection
/// field set of the offered monsters — no IVs/EVs/nature (ADR-0015 / TR-19).
/// The public `initiator_currency` / `counterparty_currency` fields leak a LOWER
/// BOUND on the offering party's private balance to all subscribers — an accepted
/// bounded exposure (offered amounts only, never the full balance; ADR-0117 D6,
/// amending ADR-0106 M-2). `inventory` is a genuine precedent (world-readable
/// pending transport RLS); `player_wallet` is NOT a precedent — it is PRIVATE
/// must-never-leak (ADR-0015 / ADR-0081). `trade_offer` is flagged for the same
/// transport-RLS treatment as `inventory` / `player_wallet` when per-row RLS lands.
///
/// SpacetimeDB reducers execute serially (single-threaded WASM): a `confirm_trade`
/// read-check-delete is atomic w.r.t. all other reducers — no TOCTOU possible
/// (ADR-0106 D8). Do NOT add physical escrow rows; the guard-in-place pattern is
/// the SSOT invariant.
///
/// Terminal state: the row is DELETED (not updated to Cancelled) — mirrors battle
/// terminal GC (M12.5e, ADR-0077). This means no trade history is retained; a
/// history table is a follow-up concern (M16+).
#[spacetimedb::table(accessor = trade_offer, public)]
pub struct TradeOffer {
    #[primary_key]
    #[auto_inc]
    pub trade_id: u64,
    /// Trade initiator (the player who called `propose_trade`).
    #[index(btree)]
    pub initiator: Identity,
    /// Designated counterparty.
    #[index(btree)]
    pub counterparty: Identity,
    /// Monster IDs offered by the initiator (escrowed; may be empty).
    pub initiator_monster_ids: Vec<u64>,
    /// Items offered by the initiator (escrowed; may be empty).
    pub initiator_items: Vec<game_core::TradeItem>,
    /// Currency offered by the initiator (0 = none).
    pub initiator_currency: u64,
    /// Monster IDs offered by the counterparty (escrowed; may be empty).
    pub counterparty_monster_ids: Vec<u64>,
    /// Items offered by the counterparty (escrowed; may be empty).
    pub counterparty_items: Vec<game_core::TradeItem>,
    /// Currency offered by the counterparty (0 = none).
    pub counterparty_currency: u64,
    /// Display-only snapshots of the initiator's offered monsters (no hidden genes — ADR-0015 / TR-19).
    pub initiator_cards: Vec<game_core::MonsterCard>,
    /// Display-only snapshots of the counterparty's offered monsters (no hidden genes — ADR-0015 / TR-19).
    pub counterparty_cards: Vec<game_core::MonsterCard>,
    /// Lifecycle state. Pending → ConfirmedByCounterparty → (deleted on swap or cancel).
    pub status: game_core::TradeStatus,
    /// Timestamp (server clock ms) when the offer was created.
    pub created_at_ms: i64,
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
#[spacetimedb::table(accessor = player_wallet)]
pub struct PlayerWallet {
    #[primary_key]
    pub owner_identity: Identity,
    pub balance: u64,
}

/// Owner-scoped read path for `player_wallet` (ADR-0154): each client's
/// subscription sees ONLY its own row, via the `owner_identity` unique index —
/// never a whole-table scan. The table stays PRIVATE (ADR-0087 precedent set by
/// `my_conversation` above): this view is the single sanctioned client read
/// path, so `Option` is load-bearing — "no row" stays distinguishable from
/// "balance 0" and must never be flattened through `economy::wallet_balance`.
/// Lives next to the table it projects (visibility is a schema artifact).
#[spacetimedb::view(accessor = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender())
}

// --- M21 account tables (ADR-0179 D2) ------------------------------------------

/// Lifecycle state of an account (ADR-0179 D7). M21 gates `PendingDeletion` in
/// exactly one place (`complete_guest_claim`) via `accounts::is_pending_deletion`;
/// M22 extends `delete_account`'s body with the grace window + cascade. Written
/// one variant per line deliberately — the type-snapshot regex terminates a body
/// on a newline before the closing brace, so a single-line body is invisible to
/// the baseline (`spacetime-type-snapshot.eval.mjs`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, spacetimedb::SpacetimeType)]
pub enum AccountStatus {
    Active,
    PendingDeletion,
}

/// PRIVATE account record (no `public`) — one row per authenticated identity
/// (ADR-0179 D2). No email, no email hash, no raw JWT `sub` (D9 / AUTH-6):
/// `Identity = f(iss, sub)` already keys every game-data table since M2, so an
/// account needs no PII of its own. Clients read ONLY through the `my_account`
/// view below. Runtime table, not seeded content → NO CONTENT_VERSION bump
/// (D10, mirrors `trade_offer` / ADR-0106). `Clone` (derived BEFORE the table
/// attr — the `player_quest` precedent, so the schema-snapshot regex still
/// matches `#[spacetimedb::table(...)] pub struct`) supports value-style unit
/// tests over the pure seams that take an `Account` by value.
///
/// LEGAL-STATE INVARIANT (ADR-0195): the `status`/`deletion_requested_at_ms`
/// pairing and the `claimed_from`/`claimed_at_ms` pairing are enforced by
/// `accounts::account_state_is_legal`, checked via `debug_assert!` in the five
/// pure Account-returning constructors, and pinned by
/// `schema_account_struct_shape_tripwire` in `accounts_tests.rs`. The enum
/// fold that would make those illegal states unrepresentable is deliberately
/// deferred: it changes live column TYPES, a non-additive migration
/// (ADR-0195 D1).
#[derive(Clone)]
#[spacetimedb::table(accessor = account)]
pub struct Account {
    #[primary_key]
    pub identity: Identity,
    /// The `iss` claim this account was provisioned under (audit only).
    /// `Identity = f(iss, sub)`, so a different issuer is a different identity,
    /// hence a different row (ADR-0179 D1). ONE sanctioned update exists
    /// (M22 §3, ADR-0207): the account-deletion cascade overwrites this column
    /// with the `game_core::TOMBSTONE_AUTH_ISSUER` sentinel String — a sentinel,
    /// not a widening to `Option<String>`, which would be a non-additive column
    /// edit. No other code path may write it after insert.
    pub auth_issuer: String,
    pub created_at_ms: i64,
    pub last_login_at_ms: i64,
    pub status: AccountStatus,
    pub deletion_requested_at_ms: Option<i64>,
    /// The guest identity this account claimed, if any (audit provenance;
    /// must survive by design — set once, never re-keyed, AUTH-21).
    pub claimed_from: Option<Identity>,
    pub claimed_at_ms: Option<i64>,
    /// M22 terminal marker (spec §4.1, ADR-0207): stamped by the deletion
    /// reaper ONLY after the whole cascade completed without error. Terminal
    /// predicate: `status == PendingDeletion && terminal_at_ms.is_some()` —
    /// deliberately an additive column, not a third `AccountStatus` variant
    /// (variant append risks a destructive republish, ADR-0174 D-freeze +
    /// ADR-0197). Appended LAST with a default so the column is an additive
    /// automigration under ADR-0006. `Some` is written ONLY by
    /// `account_deletion_reaper`'s cascade (m22-s3b, ADR-0228 —
    /// `terminal_account`, the body's last statement).
    #[default(None)]
    pub terminal_at_ms: Option<i64>,
}

/// Owner-scoped read path for `account` (ADR-0179 D2, mirroring `my_wallet`
/// above / ADR-0154 D2). `public` on the `#[view]` keyword is a mandatory,
/// inert token — THIS BODY is the entire security boundary and must stay pinned
/// to exactly this expression, not merely contain it (a decoy `find(ctx.sender())`
/// followed by `find(other)` compiles clean and leaks; ADR-0154 D2's attack
/// applies identically here).
#[spacetimedb::view(accessor = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db.account().identity().find(ctx.sender())
}

/// PRIVATE in-flight guest→account claim (no `public`) — one row per guest
/// identity (ADR-0179 D2/D3). `code` is CLIENT-minted 256-bit entropy
/// (`crypto.getRandomValues`), stored plaintext; server RNG is never a CSPRNG
/// here (D3 / AUTH-11). `#[unique]` with NO adjacent `#[index(btree)]` — a
/// unique column already supports `.find()` (the `npc.npc_id` convention).
/// `guest_name` is a server-populated snapshot of `player.name`, never a reducer
/// argument (AUTH-9), rendered back only to the same person completing the claim.
/// `Clone` derived before the table attr (see `Account`) for value-style tests.
#[derive(Clone)]
#[spacetimedb::table(accessor = guest_claim)]
pub struct GuestClaim {
    #[primary_key]
    pub guest_identity: Identity,
    #[unique]
    pub code: String,
    pub guest_name: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

// --- M17a ranked-ladder table (ADR-0119) ---------------------------------------

/// Persistent per-player ranked-ladder record (M17, ADR-0119 D1) — the
/// progression counterpart to the ephemeral `player` presence row.
///
/// PUBLIC = world-readable leaderboard record (ADR-0015 stakes classification:
/// public-low-stakes — the name is already public on `player`; rating/W/L are
/// the leaderboard's whole point). NEVER deleted (ADR-0119 D1): no code path
/// removes a `profile` row — `on_disconnect` does not touch it (structural
/// never-deleted scan). Runtime table, not seeded content → NO CONTENT_VERSION
/// bump (ADR-0106 D7 precedent, mirrors `trade_offer`). No `#[index(btree)]`
/// on `rating` in m17a — the m17b leaderboard sorts client-side over a full
/// `profile` subscription; add an index if/when server-side range queries land.
#[spacetimedb::table(accessor = profile, public)]
pub struct Profile {
    #[primary_key]
    pub identity: Identity,
    /// Display name, seeded from the `player` row at first rating application.
    pub name: String,
    /// Integer Elo rating; may legitimately go negative (no floor, ADR-0119 D2).
    pub rating: i32,
    pub wins: u32,
    pub losses: u32,
}

// --- M16a PvP tables (ADR-0109) ----------------------------------------------

/// Lifecycle state of a PvP challenge (M16a, ADR-0109).
///
/// `Pending` → `Accepted` (creates the `battle` row) OR
/// `Declined` / `Cancelled` (row deleted immediately).
/// Terminal rows are DELETED (not stored) — mirrors trade/battle GC policy.
#[derive(Clone, Copy, PartialEq, Eq, Debug, spacetimedb::SpacetimeType)]
pub enum ChallengeStatus {
    Pending,
    Accepted,
    Declined,
    Cancelled,
}

/// A pending PvP challenge from one player to another (M16a, ADR-0109).
///
/// PUBLIC so both the challenger and the target can subscribe and display the
/// incoming/outgoing challenge UI (m16b).  Terminal challenges (Accepted,
/// Declined, Cancelled) are DELETED immediately after processing — no history
/// table in M16; follow-up in M17+.
/// Pending rows expire via the challenge TTL reaper (pvp.rs, ADR-0126).
#[spacetimedb::table(accessor = battle_challenge, public)]
pub struct BattleChallenge {
    #[primary_key]
    #[auto_inc]
    pub challenge_id: u64,
    /// Player who sent the challenge.
    #[index(btree)]
    pub challenger: Identity,
    /// Designated opponent.
    #[index(btree)]
    pub target: Identity,
    /// Challenger's committed party for the PvP battle.
    pub challenger_party_ids: Vec<u64>,
    pub status: ChallengeStatus,
    pub created_at_ms: i64,
}

/// PRIVATE per-turn secret action submitted by one PvP player (M16a, ADR-0109).
///
/// MUST-NEVER-LEAK (ADR-0015, ADR-0109 D2): a leaked pending pick is a
/// competitively decisive exploit (opponent adapts their choice). No `public`,
/// no separate view, no RLS projection. The table is invisible to all clients; they
/// discover that a turn resolved by watching `battle.state.turn_number`
/// increment via the `my_battle` view onto the now-private `battle` table
/// (ADR-0198 — `battle` itself stopped being `public` after this comment was
/// written).
///
/// Two rows exist per turn (one per side); both are deleted atomically when
/// `resolve_pvp_turn_if_ready` fires in the same transaction.
#[spacetimedb::table(accessor = battle_action)]
pub struct BattleAction {
    #[primary_key]
    #[auto_inc]
    pub action_id: u64,
    /// Links this action to the ongoing PvP battle.
    #[index(btree)]
    pub battle_id: u64,
    /// The submitting player (player_identity = side A; opponent_identity = side B).
    pub player_identity: Identity,
    /// The chosen action (Attack or Swap — never Pass, which is server-generated).
    pub action: game_core::PvpAction,
    /// Turn this action applies to; must match `battle.state.turn_number` at
    /// submission time (double-submit / stale-action defense-in-depth).
    pub turn_number: u16,
    /// Server clock at submission (ms).  Informational; not used for resolution.
    pub submitted_at_ms: i64,
}

// --- M22 data lifecycle (privacy, deletion, export — spec §3/§5, ADR-0207) ----

/// PRIVATE per-owner data-export chunk (M22 §5, ADR-0207). One row per
/// `(owner_identity, request_id, table_name)`, sub-chunked at
/// `game_core::EXPORT_CHUNK_ROWS` via `chunk_index`/`total_chunks` — the frozen
/// S2↔S4↔S8 chunk contract. S4's `request_data_export` writes rows; the
/// owner-scoped `my_export_bundle` view (S4) is the ONLY client read path —
/// like `account`, `public` here would hand one player's whole personal-data
/// dump to every client. `created_at_ms` is server-stamped at insert; the S4
/// TTL reaper re-derives staleness from it plus the injected clock, so no
/// caller can supply it. Synthetic `chunk_id` PK: views strip primary keys, and
/// a `#[primary_key]`+`#[auto_inc]` column may carry no default, so the row
/// needs its own key. `request_id` is MINTED BY S4 (generation strategy is
/// S4's decision); chunk-tuple uniqueness (owner, request, table, chunk_index)
/// is REDUCER-enforced in S4 — a multi-column unique constraint is not
/// expressible here, and adding `#[unique]` to a live table later is an
/// automigration-FORBIDDEN change, so the synthetic PK stays the only key.
/// `Clone` derived BEFORE the table attr (the `Account`
/// precedent — the schema-snapshot regex must still match
/// `#[spacetimedb::table(...)] pub struct`).
#[derive(Clone)]
#[spacetimedb::table(accessor = export_bundle)]
pub struct ExportBundle {
    #[primary_key]
    #[auto_inc]
    pub chunk_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub request_id: u64,
    pub table_name: String,
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub payload_json: String,
    pub created_at_ms: i64,
}

/// Deletion policy for one table's rows at account-cascade time (M22 §3).
///
/// `ViaJoin` carries the OWNING PARENT table's accessor name: the row has no
/// `Identity` column of its own and is swept transitively at the parent's
/// cascade step. Encoding the parent inside the variant makes "is join-only"
/// and "has a parent" the same fact by construction — a separate optional
/// parent field would reintroduce representable-but-illegal states.
#[derive(Debug)]
pub enum DeletionPolicy {
    /// Row deleted outright at cascade time.
    Erase,
    /// Row survives; its identity or PII fields are overwritten with the S1
    /// tombstone constants via a PK-keyed update.
    Anonymize,
    /// No `Identity` column; swept transitively via the named parent table.
    ViaJoin(&'static str),
    /// Holds no per-player data; the mandatory `basis` says why.
    NotOwned,
}

/// One table's data-lifecycle classification (M22 §3 + §5).
pub struct DataLifecycleEntry {
    /// The table's accessor name, exactly as declared in its table attribute.
    pub table: &'static str,
    /// What the deletion cascade does with this table's rows.
    pub policy: DeletionPolicy,
    /// Mandatory prose reason. NEVER put a slash in this string: the schema
    /// snapshot gate parses RAW source with a string-unaware comment stripper,
    /// so one comment delimiter inside a string literal silently truncates the
    /// parsed table set (measured; gate-tested in `accounts_tests.rs`).
    pub basis: &'static str,
    /// Third, orthogonal axis (M22 §5): does `request_data_export` include this
    /// table? Export scope is structurally NARROWER than deletion scope.
    pub exportable: bool,
}

/// THE data-lifecycle manifest (M22 §3, ADR-0207): exactly one entry per live
/// table, gate-enforced bidirectionally by
/// `data_lifecycle_manifest_totality_bidirectional` in `accounts_tests.rs`, so
/// a new table cannot silently retain personal data — adding a table without
/// classifying it here is a hard test failure, and a stale entry for a removed
/// table is too.
///
/// The classification is spec §3's exhaustive partition (12 ERASE + 4
/// ANONYMIZE + 5 JOIN-ONLY + 17 NOT-OWNED over the 38 pre-M22 tables) plus
/// m22-s2's own `export_bundle` (ERASE) and rb-24's
/// `account_deletion_reaper_schedule` (NOT-OWNED, ADR-0221) — 40 entries. Do
/// not re-partition: add new tables with their own entry. The claim-flow
/// re-key axis lives separately as `REKEY_MANIFEST` in
/// `evals/guest-claim-integrity.eval.mjs` (per-column, consumed by G6); a
/// cross-manifest gate test ties the two together.
pub const DATA_LIFECYCLE_MANIFEST: &[DataLifecycleEntry] = &[
    // --- ERASE: rows deleted outright at cascade time (spec §3 twelve, plus
    // --- this slice's own export_bundle). ---
    DataLifecycleEntry {
        table: "monster",
        policy: DeletionPolicy::Erase,
        basis: "owned monster rows are purely personal state, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "monster_pub",
        policy: DeletionPolicy::Erase,
        basis: "public projection of an owned monster, deleted with its private twin",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "inventory",
        policy: DeletionPolicy::Erase,
        basis: "owned item stacks are purely personal state, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "player_dialogue_state",
        policy: DeletionPolicy::Erase,
        basis: "owned single-player NPC dialogue progress, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "player_quest",
        policy: DeletionPolicy::Erase,
        basis: "owned quest progress rows, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "player_conversation",
        policy: DeletionPolicy::Erase,
        basis: "single-player NPC dialogue progress, not chat (no messaging system exists), \
                deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "heal_cooldown",
        policy: DeletionPolicy::Erase,
        basis: "owned heal-cooldown marker, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "player_wallet",
        policy: DeletionPolicy::Erase,
        basis: "owned currency balance, deleted outright at cascade time",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "playtest_event",
        policy: DeletionPolicy::Erase,
        basis: "identity-scoped dev telemetry: the cascade erases it immediately, independent \
                of the ADR-0131 TTL reaper (a row younger than its TTL must not survive \
                account deletion)",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "trade_offer",
        policy: DeletionPolicy::Erase,
        basis: "only pending offers exist (terminal rows are deleted immediately, per the \
                table doc); both identity columns are swept",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "battle_challenge",
        policy: DeletionPolicy::Erase,
        basis: "only pending challenges exist; challenger AND target columns are swept, \
                closing the G6-flagged incoming-challenge orphan",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "battle_action",
        policy: DeletionPolicy::Erase,
        basis: "transient per-turn action state keyed to a battle, deleted outright",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "export_bundle",
        policy: DeletionPolicy::Erase,
        basis: "an export snapshot is itself personal data: swept at cascade time in \
                addition to its own S4 TTL reaper",
        exportable: false,
    },
    // --- ANONYMIZE: rows survive; identity or PII fields are tombstoned. ---
    DataLifecycleEntry {
        table: "player",
        policy: DeletionPolicy::Anonymize,
        basis: "the presence row survives as the anchor that character and live multi-user \
                rows point at; name is overwritten with the tombstone",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "profile",
        policy: DeletionPolicy::Anonymize,
        basis: "ADR-0119 never-delete invariant: the ladder row survives and name is \
                overwritten with the tombstone (anonymize is a field update, never a delete, \
                so the invariant holds by construction)",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "account",
        policy: DeletionPolicy::Anonymize,
        basis: "auth_issuer is overwritten with TOMBSTONE_AUTH_ISSUER (a sentinel String, \
                never a nullable widening); identity and claim provenance are retained per \
                AUTH-29 so a cancel chain never reads as un-claimed",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "battle",
        policy: DeletionPolicy::Anonymize,
        basis: "terminal rows persist and a surviving opponent still resolves them via \
                my_battle, so the deleting side's identity column is swapped to \
                TOMBSTONE_IDENTITY (never zero, which would reclassify the row as wild); \
                the row itself survives",
        exportable: true,
    },
    // --- JOIN-ONLY: no Identity column; swept via the owning parent's step. ---
    DataLifecycleEntry {
        table: "character",
        policy: DeletionPolicy::ViaJoin("player"),
        basis: "no Identity column; erased via the owning player row's entity_id join, \
                sequenced BEFORE the player tombstone write",
        exportable: true,
    },
    DataLifecycleEntry {
        table: "battle_wild",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; carries the raw RNG individuality seed (must never \
                leak) and is swept via its owning battle row",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "pvp_deadline_schedule",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; per-battle deadline schedule swept via its owning \
                battle row",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_challenge_reaper_schedule",
        policy: DeletionPolicy::ViaJoin("battle_challenge"),
        basis: "no Identity column; per-challenge TTL schedule swept via its owning \
                challenge row",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "trade_offer_reaper_schedule",
        policy: DeletionPolicy::ViaJoin("trade_offer"),
        basis: "no Identity column; per-offer TTL schedule swept via its owning trade \
                offer row",
        exportable: false,
    },
    // --- NOT-OWNED: no per-player data; the basis is the mandatory reason. ---
    DataLifecycleEntry {
        table: "config",
        policy: DeletionPolicy::NotOwned,
        basis: "module-owner singleton: owner_identity is a zeroed default, not a per-row \
                key, so a cascade acting on it would delete global game config",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "guest_claim",
        policy: DeletionPolicy::NotOwned,
        basis: "consumed at claim time or reaped on a short TTL; a claimed account row \
                never coexists with its pre-claim guest row (and the code is a secret)",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "guest_claim_reaper_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "one-shot TTL schedule consumed with its claim; never coexists with a \
                claimed account",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "account_deletion_reaper_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "one-shot deletion-grace schedule (rb-24, ADR-0221): armed only by the \
                account holder's own delete_account, disarmed by cancel, and the fired \
                row is deleted by the runtime itself — so no row survives the cascade \
                its own reducer runs, and an Erase entry would demand the D6 \
                self-disarm anti-pattern",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "zone_def",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded world content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "species_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded species registry content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "skill_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded skill registry content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "type_relation_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded type-chart content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "item_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded item registry content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "shop_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded shop registry content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "shop_item_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded shop stock content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "encounter",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded encounter table content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "evolution_path",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded evolution graph content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "npc",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded NPC registry content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "heal_location_row",
        policy: DeletionPolicy::NotOwned,
        basis: "seeded heal location content, not player data",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "movement_tick_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "global movement tick schedule, not keyed to any player",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "mr_heartbeat_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "global observability heartbeat schedule, not keyed to any player",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "playtest_reaper_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "global TTL reaper schedule for playtest_event, not keyed to any player",
        exportable: false,
    },
];

/// Compile-time well-formedness of the manifest: every entry names a table,
/// carries non-empty basis prose, and every `ViaJoin` names a non-empty parent.
/// Evaluated in the anonymous const below, so a violation is a COMPILE ERROR —
/// and that evaluation is also what keeps the manifest (every field, including
/// the `ViaJoin` payload) live in the lib target under `-D warnings` (S3's
/// cascade is its first runtime consumer; until then the const-eval read is
/// the non-test use).
const fn manifest_is_wellformed(entries: &[DataLifecycleEntry]) -> bool {
    let mut i = 0;
    while i < entries.len() {
        let entry = &entries[i];
        if entry.table.is_empty() || entry.basis.is_empty() {
            return false;
        }
        let parent_ok = match &entry.policy {
            DeletionPolicy::ViaJoin(parent) => !parent.is_empty(),
            DeletionPolicy::Erase | DeletionPolicy::Anonymize | DeletionPolicy::NotOwned => true,
        };
        if !parent_ok {
            return false;
        }
        // Const-eval read of the remaining field, so every field of the entry
        // struct is consumed by the lib target itself.
        let _ = entry.exportable;
        i += 1;
    }
    !entries.is_empty()
}

const _: () = assert!(manifest_is_wellformed(DATA_LIFECYCLE_MANIFEST));
