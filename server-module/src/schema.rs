//! `schema` — server-module domain submodule.
//!
//! The data `#[spacetimedb::table]` structs + their row types. The shared
//! `game-core` type IS the schema (never re-declared); time columns are `i64` ms
//! (round-trip `game_core::Millis`). Tables are additive; world tables
//! carry an indexed `zone_id`.
//!
//! Exception: the `movement_tick_schedule` scheduled table lives with its
//! `movement_tick` reducer in `movement.rs` so the `scheduled(movement_tick)`
//! reference resolves.
//!
//! Cross-module `ctx.db.<table>()` callers must import the generated snake_case
//! accessor trait (e.g. `use crate::schema::config;`).

use game_core::{
    ActionState, Affinity, BattleState, Direction, MoveInput, NatureKind, NpcInteraction, StatKind,
    StatusKind, TrustTier,
};
use spacetimedb::{ConnectionId, Identity, ReducerContext, Table};

// --- Tables (additive; world tables carry an indexed zone_id) ---

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

// --- Content tables (public, world-readable, module-write-only) --

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
    pub ability: Option<u32>, // additive; None = no passive ability
    // Evolution-graph tier: 0 = a base, wild-catchable
    // form; every evolution edge advances exactly +1 (R5). Tail-appended with an
    // explicit default.
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
    /// Currency the player receives when selling this item.
    /// 0 = item cannot be sold (`sell` reducer rejects). Seeded 1:1 from
    /// `ItemDef.sell_price` (content SSOT).
    pub sell_price: u64,
    /// Status condition this item cures when used in battle via `use_battle_item`.
    /// None for non-cure items. Seeded 1:1 from `ItemDef.cure_status` (content
    /// SSOT) so the client classifies cure items by data, not by hardcoded id
    /// (additive).
    pub cure_status: Option<StatusKind>,
}

// --- Shop tables: public content, world-readable ---

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

// --- Encounter table ----

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
/// projection and no RLS filter.
#[spacetimedb::table(accessor = encounter)]
pub struct EncounterRow {
    #[primary_key]
    pub zone_id: u32,
    pub encounter_rate: u16,
    pub entries: Vec<EncounterEntryRow>,
}

// --- Monster tables --

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
    // Hidden genes — MUST NEVER reach non-owner clients
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
    // Per-monster care cooldown anchor: server clock ms of the
    // last successful `care`. Additive. New monsters start at 0 (epoch
    // ⇒ cooldown elapsed ⇒ first care allowed). Mirrored verbatim onto
    // `monster_pub` since qf-3 (the owner's sheet reads readiness from it);
    // this private row stays the one the `care` reducer checks.
    pub last_care_at_ms: i64,
    // (`bond` and `evolves_to` were removed here by Migration B.
    // A column removal is always rejected by automatic migration.
    // --- EG1 Migration A: 16 appended columns. APPEND-AT-END ONLY:
    // live spacetime 2.6.0 accepts an automatic migration only as tail-appended
    // columns each carrying an explicit default; a mid-struct
    // insert is a live-DB migration rejection. Trust and Quality-Time SEMANTICS.
    // Per-Affinity essence pools, in Affinity declaration order (Fire..Dark) —
    // the same order as Affinity::ALL and MonsterInstance.essence.
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
    // Lifetime Trust event counters (tiering via game_core::trust_tier_of).
    #[default(0)]
    pub trust_favorable_count: u32,
    #[default(0)]
    pub trust_unfavorable_count: u32,
    // Server-only Trust bookkeeping: day-epoch anchor for the once-per-24h
    // favorable battle credit.
    #[default(0)]
    pub trust_favorable_battle_day_epoch: u32,
    // Lifetime Quality-Time ticks (tiering via quality_time_tier_of).
    #[default(0)]
    pub quality_time_ticks_total: u32,
    // Server-only Quality-Time accumulators.
    #[default(0)]
    pub quality_time_accum_ms: u32,
    #[default(0)]
    pub quality_time_window_ms: u32,
    // NOTE: the two i64 columns carry a TYPED 0i64 literal — an untyped 0 in
    // #[default(..)] BSATN-encodes as 4 bytes and the publish rejects with
    // "data too short for i64" (measured on live spacetime).
    #[default(0i64)]
    pub quality_time_window_start_ms: i64,
    // Essence-training cooldown anchor, server clock ms.
    #[default(0i64)]
    pub last_essence_train_at_ms: i64,
}

/// Safe projection of the monster table — NO hidden fields (no IVs, EVs,
/// nature). PRIVATE (need-to-know): clients read
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
    // (`bond` and `evolves_to` were removed here by Migration B.)
    // --- EG1 Migration A: 12 appended public columns. APPEND-AT-
    // END ONLY with explicit defaults. are derived server-side, never
    // client-written.
    // Evolution-graph tier of this monster's species: written fresh at
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
    // Derived Trust tier: with K=10 smoothing, zero history is
    // exactly 0.5 — the 5-band midpoint — so Neutral is the correct default.
    #[default(TrustTier::Neutral)]
    pub trust_tier: TrustTier,
    // Derived Quality-Time tier.
    #[default(0)]
    pub quality_time_tier: u8,
    // Derived Nutrition percentage of the 510 EV budget.
    #[default(0)]
    pub nutrition_pct: u8,
    // qf-3: the care cooldown anchor, copied VERBATIM from `monster` by
    // `pub_from_monster` so the owner's Monsters sheet can render Care
    // readiness (through the client-wasm `care_remaining_ms` export, the
    // only client reading of it). Server-epoch ms of the last successful
    // care. 0 = never cared, or a row not yet rewritten since qf-3 (reads as
    // ready; the server's own check on `monster` still rejects an early care).
    // Appended with a TYPED default: an untyped `0` encodes as 4 bytes and
    // fails the live publish. Owner-only: `monster_pub` is private behind
    // `my_monster_pub`.
    #[default(0i64)]
    pub last_care_at_ms: i64,
}

/// Owner-scoped read path for `monster_pub`: each
/// client's subscription sees ONLY its own rows, via the `owner_identity`
/// btree index — a point index scan, never a table scan. First multi-row
/// (`Vec`) view in the module: the return type no longer bounds the result
/// set, so THIS BODY is the entire security boundary
/// and is pinned exactly signature included (a 1.12.0 view accepts extra
/// args; an extra `owner` param is a caller-chosen-owner leak). Lives next
/// to the table it projects (visibility is a schema artifact — the
/// `my_conversation`/`my_wallet`/`my_account` convention).
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db
        .monster_pub()
        .owner_identity()
        .filter(ctx.sender())
        .collect()
}

// --- Battle table (private since 15r-sec-a) ----------

/// A single PvE or PvP battle. The `state` column holds the full `BattleState`
/// (pure data from `game-core`); the server module is the ONLY writer. PRIVATE:
/// a public battle table delivered every live
/// battle's both-side derived stats, HP, skills and status to every connected
/// client.
/// Participants read ONLY their own rows through the `my_battle` view below.
/// Hidden fields (IVs/EVs) are NOT in `BattleState` — only derived stats appear
/// there — so the view leaks nothing hidden to the two
/// players who are already in the fight.
///
/// `opponent_identity` gains a btree index to support O(log n)
/// lookup in `forfeit_on_disconnect` for the case where the disconnecting player is
/// the opponent (side B).  Adding an index is additive: no column or PK
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

/// Participant-scoped read path for `battle`: each client's
/// subscription sees ONLY rows where it holds `player_identity` OR
/// `opponent_identity` — a chain of two point index scans over the btree
/// indexes above, never a table scan. Like `my_monster_pub`, THIS BODY is the
/// entire security boundary and is pinned exactly
/// signature included (an extra param is a
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

/// PRIVATE wild-individuality side-table. Keyed 1:1 by
/// `battle_id`. Stores the splitmix32 `individuality_seed` that M8d re-feeds to
/// `roll_individuality` to rebuild the EXACT wild that was fought. NO `public`:
/// the raw RNG-derived seed must never reach any client (no projection, no RLS
/// filter, no generated accessor — mirrors the private `encounter` table).
/// M8c only WRITES this row; M8d reads/clears it.
#[spacetimedb::table(accessor = battle_wild)]
pub struct BattleWild {
    #[primary_key]
    pub battle_id: u64,
    pub wild_species_id: u32,
    pub wild_level: u8,
    pub individuality_seed: u32,
}

/// PRIVATE player item inventory (no `public`): item counts are owner-private
/// (scouting another player's stock is a competitive leak). Clients read ONLY
/// their own rows through the `my_inventory` view below; reducers read the
/// table directly. Carries ONLY ownership + count — NO gene/seed fields;
/// individuality stays in the private `monster` table. Single-stack invariant:
/// at most ONE row per `(owner_identity, item_id)`, enforced by routing every
/// insert through `grant_item` — there is no DB-level composite unique
/// constraint (unsupported in this toolchain).
#[spacetimedb::table(accessor = inventory)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}

/// Owner-scoped read path for `inventory`: each client's subscription sees ONLY
/// its own stacks, via the `owner_identity` btree index (a point index scan).
/// A multi-row (`Vec`) view, so THIS BODY is the entire security boundary: the
/// one-parameter signature is load-bearing (an extra `owner` param would be a
/// caller-chosen-owner leak). Same shape as `my_monster_pub`.
#[spacetimedb::view(accessor = my_inventory, public)]
fn my_inventory(ctx: &spacetimedb::ViewContext) -> Vec<Inventory> {
    ctx.db
        .inventory()
        .owner_identity()
        .filter(ctx.sender())
        .collect()
}

// --- evolution-graph tables ---------------------------------

/// One per-Affinity essence requirement on an evolution edge. Nested
/// SpacetimeType, mirroring the EncounterEntryRow precedent above. The field
/// set is FROZEN at publish and Vec semantics are AND-only — every entry
/// must be met.
#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct EssenceRequirementRow {
    pub affinity: Affinity,
    pub amount: u32,
}

/// PUBLIC evolution-graph edge table, seeded clear-and-reinsert from
/// the game-core evolution_paths registry by sync_content. Clients subscribe to
/// it for the requirements panel; the evolve reducer reads it for the
/// targeted gate lookup.
///
/// IDENTITY: path_id is DB-internal ONLY — an auto_inc value reminted
/// on every reseed, NEVER durable identity. edge_id is THE durable, author-
/// assigned, append-only edge identity.
///
/// INDEX: this toolchain has no composite unique constraint, so
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

/// One post-evolve reveal, queued for the monster's owner.
/// Nested SpacetimeType, mirroring the `EssenceRequirementRow` precedent above.
/// The field set is FROZEN at publish, so the display timestamp ships now even
/// though only the species pair drives the banner text.
///
/// `from_species` and `to_species` are the edge's OWN endpoints, copied off the
/// immutable `EvolutionPathRow` the transform was applied through — never read
/// back off the monster row, which by then already carries the TARGET species.
/// `evolved_at_ms` is the transaction clock: every entry of one chain shares
/// one stamp, so it is display metadata and never an ordering or dedupe key.
#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct EvolutionRevealRow {
    pub monster_id: u64,
    pub from_species: u32,
    pub to_species: u32,
    pub evolved_at_ms: i64,
}

/// PRIVATE per-owner queue of evolution reveals the player has not dismissed
/// yet. One row per owner, keyed by `owner_identity`;
/// `entries` is append-ordered, and Vec order IS display order.
///
/// PRIVATE on purpose: a public projection would hand every connected client
/// the full evolution history of every other player's roster (monster ids,
/// species transitions and timestamps). The owner-scoped view directly below
/// is the single sanctioned client read path.
///
/// LIFECYCLE: `evolution::apply_evolution` appends one entry per applied edge,
/// `ack_evolution_notices` drains a prefix (the row itself SURVIVES an empty
/// drain, exactly as `player_wallet` survives a zero balance), the account
/// cascade erases the row (`DeletionPolicy::Erase`) and the guest claim
/// re-keys it onto the claimed identity.
#[derive(Clone, Debug, PartialEq, Eq)]
#[spacetimedb::table(accessor = pending_evolution_notice)]
pub struct PendingEvolutionNotice {
    #[primary_key]
    pub owner_identity: Identity,
    pub entries: Vec<EvolutionRevealRow>,
}

/// Owner-scoped read path for `pending_evolution_notice` (
/// mirroring `my_wallet` below): each client's subscription sees ONLY its own
/// row, via the `owner_identity` primary key — never a whole-table scan. The
/// table stays PRIVATE, so this view is the single sanctioned client read path.
/// `Option` is load-bearing: a single-row primary-key projection
/// returns at most one row, so "no row" stays distinguishable from "an empty
/// queue". Lives next to the table it projects (visibility is a schema
/// artifact).
#[spacetimedb::view(accessor = my_pending_evolution_notices, public)]
fn my_pending_evolution_notices(ctx: &spacetimedb::ViewContext) -> Option<PendingEvolutionNotice> {
    ctx.db
        .pending_evolution_notice()
        .owner_identity()
        .find(ctx.sender())
}

// --- M12b tables: NPC, dialogue, quest, healing -------------------

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
    /// Interaction role: appended LAST (BSATN tail-append —
    /// widening a public row is wire-safe only at the tail). Threaded from
    /// `NpcDef.interaction` by `npc_row_from_def`.
    pub interaction: NpcInteraction,
}

/// PRIVATE per-player dialogue state: flags + done-quest history.
/// Must-never-leak: flags gate content branches.
/// `active_quests` is NOT stored here — derived from `player_quest` rows.
#[spacetimedb::table(accessor = player_dialogue_state)]
pub struct PlayerDialogueStateRow {
    #[primary_key]
    pub owner_identity: Identity,
    pub flags: Vec<String>,
    pub done_quests: Vec<String>,
}

/// Active quest progress. PUBLIC: every client receives every player's quest rows
/// and the client filters to its own (`store.ownQuests`). `inventory` is no longer a
/// precedent — it is private behind the owner-scoped `my_inventory` view; moving this
/// table to the same pattern is possible but not done.
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
/// PRIVATE since M13.5c: `npc_entity_id` + `current_node_id` leak
/// private quest/dialogue progress — clients read ONLY through the owner-scoped
/// `my_conversation` view below.
#[spacetimedb::table(accessor = player_conversation)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}

/// Owner-scoped read path for `player_conversation`: each client's
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
    /// Currency cost charged by `heal_party`, mirrored to the client so
    /// the heal UI can display it. Appended at the end with a typed default —
    /// bare `0` BSATN-encodes as 4 bytes and fails the automigration publish.
    #[default(0u64)]
    pub cost_currency: u64,
}

/// PRIVATE per-player heal cooldown anchor.
/// Must-never-leak: timestamp reveals heal timing.
#[spacetimedb::table(accessor = heal_cooldown)]
pub struct HealCooldown {
    #[primary_key]
    pub owner_identity: Identity,
    pub last_heal_at_ms: i64,
}

// --- M15a trade tables --------------------------------------------

/// An active trade offer between two players.
///
/// PUBLIC so both parties can subscribe and see the offer. The display data
/// (`initiator_cards` / `counterparty_cards`) contains only the public-projection
/// field set of the offered monsters — no IVs/EVs/nature.
/// The public `initiator_currency` / `counterparty_currency` fields leak a LOWER
/// BOUND on the offering party's private balance to all subscribers — an accepted
/// bounded exposure (offered amounts only, never the full balance).
/// `inventory` is a genuine precedent (world-readable
/// pending transport RLS); `player_wallet` is NOT a precedent — it is PRIVATE
/// must-never-leak. `trade_offer` is flagged for the same
/// transport-RLS treatment as `inventory` / `player_wallet` when per-row RLS lands.
///
/// SpacetimeDB reducers execute serially (single-threaded WASM): a `confirm_trade`
/// read-check-delete is atomic w.r.t. all other reducers — no TOCTOU possible.
/// Do NOT add physical escrow rows; the guard-in-place pattern is
/// the SSOT invariant.
///
/// Terminal state: the row is DELETED (not updated to Cancelled) — mirrors battle
/// terminal GC. This means no trade history is retained; a
/// history table is a follow-up concern.
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
    /// Display-only snapshots of the initiator's offered monsters (no hidden genes).
    pub initiator_cards: Vec<game_core::MonsterCard>,
    /// Display-only snapshots of the counterparty's offered monsters (no hidden genes).
    pub counterparty_cards: Vec<game_core::MonsterCard>,
    /// Lifecycle state. Pending → ConfirmedByCounterparty → (deleted on swap or cancel).
    pub status: game_core::TradeStatus,
    /// Timestamp (server clock ms) when the offer was created.
    pub created_at_ms: i64,
}

// --- M13a currency table ------------------------------------------

/// PRIVATE per-player wallet — one row per player (PK = owner_identity).
/// Balance is MUST-NEVER-LEAK: no `public`, no projection, no RLS filter.
/// The single-surface discipline requires all balance mutations to route
/// through `economy::grant_currency` / `economy::spend_currency` →
/// `game_core::currency::apply_grant` / `game_core::currency::apply_spend`.
///
/// WITHOUT the `public` attribute (privacy invariant test bites if
/// `public` is added).
#[spacetimedb::table(accessor = player_wallet)]
pub struct PlayerWallet {
    #[primary_key]
    pub owner_identity: Identity,
    pub balance: u64,
}

/// Owner-scoped read path for `player_wallet`: each client's
/// subscription sees ONLY its own row, via the `owner_identity` unique index —
/// never a whole-table scan. The table stays PRIVATE:
/// this view is the single sanctioned client read
/// path, so `Option` is load-bearing — "no row" stays distinguishable from
/// "balance 0" and must never be flattened through `economy::wallet_balance`.
/// Lives next to the table it projects (visibility is a schema artifact).
#[spacetimedb::view(accessor = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender())
}

// --- M21 account tables ------------------------------------------

/// Lifecycle state of an account. Written one variant per line deliberately — the
/// type-snapshot regex terminates a body on a newline before the closing brace, so
/// a single-line body is invisible to the baseline
/// (`spacetime-type-snapshot.eval.mjs`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, spacetimedb::SpacetimeType)]
pub enum AccountStatus {
    Active,
    PendingDeletion,
}

/// PRIVATE account record (no `public`) — one row per authenticated identity.
/// No email, no email hash, no raw JWT `sub`:
/// `Identity = f(iss, sub)` already keys every game-data table, so an
/// account needs no PII of its own. Clients read ONLY through the `my_account`
/// view below. Runtime table, not seeded content → NO CONTENT_VERSION bump.
/// `Clone` (derived BEFORE the table attr — the `player_quest` precedent, so
/// the schema-snapshot regex still matches `#[spacetimedb::table(...)] pub
/// struct`) supports value-style unit tests over the pure seams that take an
/// `Account` by value.
///
/// LEGAL-STATE INVARIANT: the `status`/`deletion_requested_at_ms`
/// pairing and the `claimed_from`/`claimed_at_ms` pairing are enforced by
/// `accounts::account_state_is_legal`, checked via `debug_assert!` in the five
/// pure Account-returning constructors, and pinned by
/// `schema_account_struct_shape_tripwire` in `accounts_tests.rs`. The enum
/// fold that would make those illegal states unrepresentable is deliberately
/// deferred: it changes live column TYPES, a non-additive migration.
#[derive(Clone)]
#[spacetimedb::table(accessor = account)]
pub struct Account {
    #[primary_key]
    pub identity: Identity,
    /// The `iss` claim this account was provisioned under (audit only).
    /// `Identity = f(iss, sub)`, so a different issuer is a different identity,
    /// hence a different row. ONE sanctioned update exists:
    /// the account-deletion cascade overwrites this column
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
    /// terminal marker: stamped by the deletion
    /// reaper ONLY after the whole cascade completed without error. Terminal
    /// predicate: `status == PendingDeletion && terminal_at_ms.is_some()` —
    /// deliberately an additive column, not a third `AccountStatus` variant
    /// (variant append risks a destructive republish).
    /// Appended LAST with a default so the column is an additive
    /// automigration. `Some` is written ONLY by
    /// `account_deletion_reaper`'s cascade.
    #[default(None)]
    pub terminal_at_ms: Option<i64>,
}

/// Owner-scoped read path for `account` (mirroring `my_wallet`
/// above). `public` on the `#[view]` keyword is a mandatory,
/// inert token — THIS BODY is the entire security boundary and must stay pinned
/// to exactly this expression, not merely contain it (a decoy `find(ctx.sender())`
/// followed by `find(other)` compiles clean and leaks).
#[spacetimedb::view(accessor = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db.account().identity().find(ctx.sender())
}

/// PRIVATE in-flight guest→account claim (no `public`) — one row per guest
/// identity. `code` is CLIENT-minted 256-bit entropy
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

// --- M17a ranked-ladder table ---------------------------------------

/// Persistent per-player ranked-ladder record — the
/// progression counterpart to the ephemeral `player` presence row.
///
/// PUBLIC = world-readable leaderboard record. NEVER deleted: no code path
/// removes a `profile` row — `on_disconnect` does not touch it. Runtime table,
/// not seeded content → NO CONTENT_VERSION bump. No `#[index(btree)]` on
/// `rating` client-side over a full `profile` subscription; add an index
/// if/when server-side range queries land.
#[spacetimedb::table(accessor = profile, public)]
pub struct Profile {
    #[primary_key]
    pub identity: Identity,
    /// Display name, seeded from the `player` row at first rating application.
    pub name: String,
    /// Integer Elo rating; may legitimately go negative (no floor).
    pub rating: i32,
    pub wins: u32,
    pub losses: u32,
}

// --- M16a PvP tables ----------------------------------------------

/// Lifecycle state of a PvP challenge.
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

/// A pending PvP challenge from one player to another.
///
/// PUBLIC so both the challenger and the target can subscribe and display the
/// incoming/outgoing challenge UI.  Terminal challenges (Accepted,
/// Declined, Cancelled) are DELETED immediately after processing — no history
/// table in M16; follow-up in M17+.
/// Pending rows expire via the challenge TTL reaper (pvp.rs).
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

/// PRIVATE per-turn secret action submitted by one PvP player.
///
/// MUST-NEVER-LEAK: a leaked pending pick is a
/// competitively decisive exploit (opponent adapts their choice). No `public`,
/// no separate view, no RLS projection. The table is invisible to all clients; they
/// discover that a turn resolved by watching `battle.state.turn_number`
/// increment via the `my_battle` view onto the now-private `battle` table.
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

// --- tactical battles (M-battle-tactics, bt-7) ----
//
// Ten PRIVATE tables and seven views. The `battle` row stays the anchor (its
// `state.outcome` still drives `is_in_ongoing_battle`); every tactical row hangs
// off `battle_id`. No table here is `public`; the client reads ONLY through the
// views below, and three tables (`battle_secret`, `battle_wild_unit`,
// `battle_summary`) have no view at all. Privacy is structural (design §6.3):
// there is no ready flag on `battle_unit`, so whether a READY plan exists is
// not derivable from any participant-visible row. Reducers, scheduled tables
// and the owning `tactics.rs` module land in bt-8; every table is additive and
// its primary key, `auto_inc` and index set are decided HERE because the
// automigration never accepts a key or uniqueness change later.
//
// game-core's `tactics::geometry::Side`, `tactics::movement::MoveClass`,
// `tactics::ai::Stance` and `tactics::economy::Entry` are deliberately not wire
// types, so each has a schema-local `SpacetimeType` twin below (variants in the
// game-core declaration order, append-only). bt-8's marshal layer owns the two
// exhaustive `match` converters per pair; an enum column cannot hold an illegal
// code the way a `u8` could.

/// `tactics::geometry::Side` as a column: `A` = 0, `B` = 1.
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SideRow {
    A,
    B,
}

/// `tactics::movement::MoveClass` as a column.
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveClassRow {
    Walk,
    Nimble,
    Swim,
    Fly,
}

/// `tactics::ai::Stance` as a column: the stance in force for a wild unit,
/// fixed from species content at materialisation (the AI re-derives its plan
/// from the public board each turn; content is the authority, this is the
/// battle's record of it). `None` on a player unit.
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum StanceRow {
    Aggressive,
    Territorial,
    Skittish,
}

/// A Move's spend (`economy::Entry::Move { strides, taxed }`).
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BudgetMoveSpend {
    pub strides: u8,
    pub taxed: bool,
}

/// `economy::TurnBudget::last` as a column (the Guard Recruit or Flee clause):
/// `economy::Entry` losslessly, `Attack(Tier)` flattened into two variants.
/// `EndTurn` never updates `last`, so it is representable but never written.
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetLastEntry {
    Move(BudgetMoveSpend),
    AttackLight,
    AttackHeavy,
    Item,
    Recruit,
    Flee,
    EndTurn,
}

/// One deploy pick: the owner's monster bound to a spawn slot of its side.
#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeployPick {
    pub monster_id: u64,
    pub slot: u8,
}

/// PRIVATE per-battle tactical state (design §8.1 `battle_tactical`), keyed
/// 1:1 by the `battle` anchor. `map_id` carries a btree index (the schema
/// eval's zoning rule: a map column is a key or an index). The three trailing
/// columns are the persistence manifest bt-3 measured beyond §8.1
/// (`tactics::queue::TacticalBattle`): the clock pad accumulated since the last
/// `Waiting`, and the adjudication's cumulative attack damage per side.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_tactical)]
pub struct BattleTactical {
    #[primary_key]
    pub battle_id: u64,
    pub kind: game_core::tactics::tuning::BattleKind,
    pub format: u8,
    #[index(btree)]
    pub map_id: u32,
    pub content_version: u32,
    pub phase: game_core::tactics::types::Phase,
    pub round: u16,
    pub initiative: Vec<u32>,
    pub turn_idx: u8,
    pub turn_state: game_core::tactics::types::TurnState,
    pub tie_priority_side: SideRow,
    pub pending_pad_ms: u32,
    pub attack_damage_dealt_a: u32,
    pub attack_damage_dealt_b: u32,
}

/// PRIVATE deployed unit (design §8.1 `battle_unit`): `side` and `owner` are
/// stored separately so a future two-ally side is just more rows. Rows exist
/// only after Deploying → Active. There is NO queue or ready field here by
/// design: both participants read every unit through `my_battle_units`, so a
/// field that revealed a pending plan would be the §6.3 leak. `owner` is a
/// sum type and carries no index; the cascade reaches units through
/// `battle_id`. `slot` and `budget_last` are the bt-3 persistence columns.
/// The unit's max HP is `stats.hp` (as `TacticalUnit::max_hp`), not a second
/// column that could disagree with it.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_unit)]
pub struct BattleUnit {
    #[primary_key]
    #[auto_inc]
    pub unit_id: u32,
    #[index(btree)]
    pub battle_id: u64,
    pub side: SideRow,
    pub owner: Option<Identity>,
    pub slot: u8,
    pub monster_id: Option<u64>,
    pub wild_index: Option<u8>,
    pub species_id: u32,
    pub level: u8,
    pub affinity: Affinity,
    pub x: u8,
    pub y: u8,
    pub cur_hp: u16,
    pub stats: game_core::StatBlock,
    pub skill_ids: Vec<u32>,
    pub status: Option<game_core::StatusEffect>,
    pub ap: u8,
    pub strides_used: u8,
    pub attacks: u8,
    pub budget_last: Option<BudgetLastEntry>,
    pub guard: bool,
    pub first_stand: bool,
    pub movement: MoveClassRow,
    pub stride: u8,
    pub stance: Option<StanceRow>,
    pub state: game_core::tactics::resolve::UnitState,
}

/// PRIVATE READY plan (design §8.1 `battle_queue`): at most one row per unit,
/// so the primary key IS `unit_id` (unit ids are global `auto_inc` keys of
/// `battle_unit`, which makes `(battle_id, unit_id)` uniqueness the same fact;
/// a multi-column unique constraint is not expressible here). Owner-only read
/// path (`my_battle_queue`); the opponent never learns a row exists.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_queue)]
pub struct BattleQueue {
    #[primary_key]
    pub unit_id: u32,
    #[index(btree)]
    pub battle_id: u64,
    #[index(btree)]
    pub owner: Identity,
    pub entries: Vec<game_core::tactics::types::QueuedAction>,
    pub submitted_at_ms: i64,
}

/// PRIVATE deploy staging (design §8.1 `battle_deploy`): the owner's picks
/// for one SIDE before materialisation; deleted when units are created. In a
/// Practice battle one owner stages both sides, hence `side`. Owner-only read
/// path (`my_battle_deploy`). Synthetic `deploy_id` key: the natural key
/// `(battle_id, side)` is a pair.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_deploy)]
pub struct BattleDeploy {
    #[primary_key]
    #[auto_inc]
    pub deploy_id: u64,
    #[index(btree)]
    pub battle_id: u64,
    #[index(btree)]
    pub owner: Identity,
    pub side: SideRow,
    pub picks: Vec<DeployPick>,
    pub locked: bool,
}

/// PRIVATE idle clock (design §8.1 `battle_clock`, `tactics::clock::ClockState`
/// column for column): one row per SIDE of a battle (`side` 0 or 1), `player`
/// naming the side's owner — in a Practice battle both rows name one player.
/// Both participants read both rows (`my_battle_clock`): the opponent's
/// window and strike count are public match state, not a secret.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_clock)]
pub struct BattleClock {
    #[primary_key]
    #[auto_inc]
    pub clock_id: u64,
    #[index(btree)]
    pub battle_id: u64,
    pub side: SideRow,
    #[index(btree)]
    pub player: Identity,
    pub window_seq: u32,
    pub window_open_ms: Option<i64>,
    pub deadline_ms: Option<i64>,
    pub windows_this_unit_turn: u8,
    pub idle_ms_total: u64,
    pub autopass_count: u8,
}

/// PRIVATE battle seed (design §8.1 `battle_secret`): the RNG seed and the
/// roll counter. NO view, ever — the `battle_wild` doctrine: a client that
/// could read the seed could replay every roll.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_secret)]
pub struct BattleSecret {
    #[primary_key]
    pub battle_id: u64,
    pub seed: u64,
    pub action_seq: u64,
}

/// PRIVATE wild individuality (design §8.1 `battle_wild_unit`): one row per
/// wild of a multi-wild encounter, carrying the splitmix seed recruit rebuilds
/// the exact wild from. NO view (the `battle_wild` doctrine). Synthetic key:
/// the natural key `(battle_id, wild_index)` is a pair.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_wild_unit)]
pub struct BattleWildUnit {
    #[primary_key]
    #[auto_inc]
    pub wild_unit_id: u64,
    #[index(btree)]
    pub battle_id: u64,
    pub wild_index: u8,
    pub species_id: u32,
    pub level: u8,
    pub individuality_seed: u32,
}

/// PRIVATE append-only event transcript (design §8.1 `battle_event`): emitted
/// only at execution, so a halted plan's discarded tail never appears. Both
/// participants read it (`my_battle_events`); bt-8's GC deletes it 24 h after
/// the battle ends.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_event)]
pub struct BattleEvent {
    #[primary_key]
    #[auto_inc]
    pub event_id: u64,
    #[index(btree)]
    pub battle_id: u64,
    pub seq: u32,
    pub round: u16,
    pub payload: game_core::tactics::events::EventPayload,
}

/// PRIVATE per-battle telemetry (design §8.1 `battle_summary`): one row per
/// finished battle, the H1 and H2 match-length source. NO view. The two
/// identity columns mirror `battle` (a wild battle's `opponent_identity` is
/// zero) so the deletion cascade can tombstone the deleting side while the
/// row survives. `windows_histogram[k]` counts unit-turns that opened `k`
/// windows; `idle_ms_a` and `idle_ms_b` are per side; `unit_turns_prequeued`
/// vs `unit_turns_live`, `halted_plans` and `se_kos_after_r1` (single-hit
/// super-effective KOs after round 1) are the BT9.5 and design §12-F inputs.
#[derive(Clone)]
#[spacetimedb::table(accessor = battle_summary)]
pub struct BattleSummary {
    #[primary_key]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    #[index(btree)]
    pub opponent_identity: Identity,
    pub kind: game_core::tactics::tuning::BattleKind,
    pub outcome: game_core::BattleOutcome,
    pub rounds: u16,
    pub wall_ms: u64,
    pub idle_ms_a: u64,
    pub idle_ms_b: u64,
    pub windows_histogram: Vec<u32>,
    pub autopasses: u16,
    pub recruit_attempts: u16,
    pub recruit_successes: u16,
    pub weaken_first: bool,
    pub items_used: u16,
    pub damage_dealt_a: u32,
    pub damage_dealt_b: u32,
    pub hits: u16,
    pub misses: u16,
    pub unit_turns_prequeued: u16,
    pub unit_turns_live: u16,
    pub halted_plans: u16,
    pub se_kos_after_r1: u16,
}

/// PRIVATE remembered formation (design §3.3, §8.1 `player_formation`): the
/// owner's preferred deploy order, at most three monster ids. One row per
/// owner (the identity IS the key); owner-only read path (`my_formation`).
#[derive(Clone)]
#[spacetimedb::table(accessor = player_formation)]
pub struct PlayerFormation {
    #[primary_key]
    pub owner_identity: Identity,
    pub monster_ids: Vec<u64>,
}

/// Every battle the caller is a side of, each exactly once: the `my_battle`
/// scan pair (two point reads over `battle`'s identity indexes; the trailing
/// filter is the practice-battle dedup, see `my_battle`). The four participant
/// views below key their per-battle point reads on this list and nothing else.
/// The zero identity (a wild battle's opponent column) and the deletion
/// tombstone are not callers: they would otherwise match every wild or every
/// anonymised battle, so they get nothing.
fn participant_battle_ids(ctx: &spacetimedb::ViewContext) -> Vec<u64> {
    let sender = ctx.sender();
    if sender == Identity::ZERO || sender == crate::TOMBSTONE_IDENTITY {
        return Vec::new();
    }
    ctx.db
        .battle()
        .player_identity()
        .filter(sender)
        .map(|b| b.battle_id)
        .chain(
            ctx.db
                .battle()
                .opponent_identity()
                .filter(sender)
                .filter(move |b| b.player_identity != sender)
                .map(|b| b.battle_id),
        )
        .collect()
}

/// Participant read path for `battle_tactical`: the tactical row of every
/// battle the caller is a side of. THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_tactical_battle, public)]
fn my_tactical_battle(ctx: &spacetimedb::ViewContext) -> Vec<BattleTactical> {
    participant_battle_ids(ctx)
        .into_iter()
        .filter_map(|id| ctx.db.battle_tactical().battle_id().find(id))
        .collect()
}

/// Participant read path for `battle_unit`: BOTH sides' units of every battle
/// the caller is in (positions, HP, stats, status and stance are public to
/// participants per design §6.3). THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_battle_units, public)]
fn my_battle_units(ctx: &spacetimedb::ViewContext) -> Vec<BattleUnit> {
    participant_battle_ids(ctx)
        .into_iter()
        .flat_map(|id| ctx.db.battle_unit().battle_id().filter(id))
        .collect()
}

/// Participant read path for `battle_event`. THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_battle_events, public)]
fn my_battle_events(ctx: &spacetimedb::ViewContext) -> Vec<BattleEvent> {
    participant_battle_ids(ctx)
        .into_iter()
        .flat_map(|id| ctx.db.battle_event().battle_id().filter(id))
        .collect()
}

/// Participant read path for `battle_clock`: both sides' clocks of every
/// battle the caller is in. THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_battle_clock, public)]
fn my_battle_clock(ctx: &spacetimedb::ViewContext) -> Vec<BattleClock> {
    participant_battle_ids(ctx)
        .into_iter()
        .flat_map(|id| ctx.db.battle_clock().battle_id().filter(id))
        .collect()
}

/// OWNER-ONLY read path for `battle_queue`: the caller's own READY rows and
/// nothing of the opponent's (design §6.3). THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_battle_queue, public)]
fn my_battle_queue(ctx: &spacetimedb::ViewContext) -> Vec<BattleQueue> {
    ctx.db.battle_queue().owner().filter(ctx.sender()).collect()
}

/// OWNER-ONLY read path for `battle_deploy`: the caller's own staging rows.
/// THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_battle_deploy, public)]
fn my_battle_deploy(ctx: &spacetimedb::ViewContext) -> Vec<BattleDeploy> {
    ctx.db
        .battle_deploy()
        .owner()
        .filter(ctx.sender())
        .collect()
}

/// OWNER-ONLY read path for `player_formation`: the caller's own row or
/// nothing. THIS BODY is the whole boundary.
#[spacetimedb::view(accessor = my_formation, public)]
fn my_formation(ctx: &spacetimedb::ViewContext) -> Option<PlayerFormation> {
    ctx.db
        .player_formation()
        .owner_identity()
        .find(ctx.sender())
}

// --- tactical tables: cascade + claim-flow helpers (bt-7) ----
//
// The tactical tables have no domain module until bt-8 lands `tactics.rs`, and
// `accounts.rs` writes only its own tables (its WRITE-ISOLATION header), so the
// three helpers the accounts paths delegate to live HERE, beside the tables
// they write. bt-8 may re-home them with the reducers.

/// True if `identity` owns a `player_formation` row (a REKEY-policy table, so
/// it counts as game data for `accounts::account_has_game_data`).
pub(crate) fn has_formation(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .player_formation()
        .owner_identity()
        .find(identity)
        .is_some()
}

/// Re-key the guest's `player_formation` row onto the claimer (PK-on-owner:
/// find, delete, insert under `to`). The claim flow refuses a destination
/// that already plays, so the two rows never coexist.
pub(crate) fn rekey_formation(ctx: &ReducerContext, from: Identity, to: Identity) {
    let Some(row) = ctx.db.player_formation().owner_identity().find(from) else {
        return;
    };
    ctx.db.player_formation().owner_identity().delete(from);
    ctx.db.player_formation().insert(PlayerFormation {
        owner_identity: to,
        monster_ids: row.monster_ids,
    });
}

/// The tactical half of the deletion cascade, called by
/// `accounts::account_deletion_reaper` immediately BEFORE
/// `battle::anonymize_battles` (after it the owner's anchors are no longer
/// findable by identity).
///
/// (1) The battle-id set is the UNION of every path that still names the
/// owner: the `battle` anchor chain (`anonymize_battles`'s two index scans),
/// `battle_clock.player`, `battle_queue.owner`, `battle_deploy.owner`, both
/// `battle_summary` identity columns, and a scan of `battle_unit` for
/// `owner == Some(owner)` (a sum type carries no index; the scan is bounded by
/// bt-8's 24 h GC). The union matters because the cascade's first step
/// (`resolve_all_live_interactions`) and the prior-terminal sweep in
/// `battle.rs` can delete an anchor row BEFORE this step runs. (2) For every id
/// in the set: delete the `battle_tactical`, `battle_secret`,
/// `battle_wild_unit`, `battle_event`, `battle_unit`, `battle_queue`,
/// `battle_deploy` and `battle_clock` rows by `battle_id` — the whole battle's
/// tactical rows go, the other participant's included: the anchor is forced
/// terminal for both sides and the transcript is GC-bound. (3) Owner-keyed
/// defence-in-depth deletes for rows naming the identity directly
/// (`battle_queue.owner`, `battle_deploy.owner`, `battle_clock.player`,
/// `player_formation`). (4) Every `battle_summary` row naming the owner on
/// either side is UPDATED once with `crate::TOMBSTONE_IDENTITY` on the matching
/// column(s) — both at once for a practice row — and survives (telemetry).
pub(crate) fn erase_tactical_rows(ctx: &ReducerContext, owner: Identity) {
    // (1) The battle-id set: every path that still names the owner.
    let mut ids: Vec<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(owner)
        .map(|b| b.battle_id)
        .collect();
    ids.extend(
        ctx.db
            .battle()
            .opponent_identity()
            .filter(owner)
            .map(|b| b.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_clock()
            .player()
            .filter(owner)
            .map(|c| c.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_queue()
            .owner()
            .filter(owner)
            .map(|q| q.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_deploy()
            .owner()
            .filter(owner)
            .map(|d| d.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_summary()
            .player_identity()
            .filter(owner)
            .map(|s| s.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_summary()
            .opponent_identity()
            .filter(owner)
            .map(|s| s.battle_id),
    );
    ids.extend(
        ctx.db
            .battle_unit()
            .iter()
            .filter(|u| u.owner == Some(owner))
            .map(|u| u.battle_id),
    );
    ids.sort_unstable();
    ids.dedup();
    // (2) The whole battle's per-battle rows, by battle id.
    for id in ids {
        ctx.db.battle_tactical().battle_id().delete(id);
        ctx.db.battle_secret().battle_id().delete(id);
        ctx.db.battle_wild_unit().battle_id().delete(id);
        ctx.db.battle_event().battle_id().delete(id);
        ctx.db.battle_unit().battle_id().delete(id);
        ctx.db.battle_queue().battle_id().delete(id);
        ctx.db.battle_deploy().battle_id().delete(id);
        ctx.db.battle_clock().battle_id().delete(id);
    }
    // (3) Owner-keyed defence in depth.
    ctx.db.battle_queue().owner().delete(owner);
    ctx.db.battle_deploy().owner().delete(owner);
    ctx.db.battle_clock().player().delete(owner);
    ctx.db.player_formation().owner_identity().delete(owner);
    // (4) Summaries survive, tombstoned once per row (a practice row names the
    // owner on both sides and is swapped on both in the same write).
    let mut summaries: Vec<BattleSummary> = ctx
        .db
        .battle_summary()
        .player_identity()
        .filter(owner)
        .collect();
    summaries.extend(
        ctx.db
            .battle_summary()
            .opponent_identity()
            .filter(owner)
            .filter(|s| s.player_identity != owner),
    );
    for s in summaries {
        let player_identity = if s.player_identity == owner {
            crate::TOMBSTONE_IDENTITY
        } else {
            s.player_identity
        };
        let opponent_identity = if s.opponent_identity == owner {
            crate::TOMBSTONE_IDENTITY
        } else {
            s.opponent_identity
        };
        ctx.db.battle_summary().battle_id().update(BattleSummary {
            player_identity,
            opponent_identity,
            ..s
        });
    }
}

// --- data lifecycle (privacy, deletion, export) ----

/// PRIVATE per-owner data-export chunk. One row per
/// `(owner_identity, request_id, table_name)`, sub-chunked at
/// `game_core::EXPORT_CHUNK_ROWS` via `chunk_index`/`total_chunks`.
/// `request_data_export` writes rows; the owner-scoped `my_export_bundle` view
/// is the ONLY client read path — like `account`, `public` here would hand one
/// player's whole personal-data dump to every client. `created_at_ms` is
/// server-stamped at insert; reaper re-derives staleness from it plus the
/// injected clock, so no caller can supply it. that column also carries a
/// FIELD-level btree index: it is what lets the TTL reaper read a bounded
/// `..=cutoff` range of expired chunks instead of the whole table on every tick.
/// Removing the index is NOT compile-coupled (a hand-written accessor of the
/// same name compiles), so the privacy_tests.rs index pin is what keeps it; and
/// the generated `created_at_ms()` accessor is a new crate-wide time-ordered
/// read over EVERY owner's chunks, census-guarded there (seven sanctioned uses,
/// all in privacy.rs). Row-invisible to clients: the table is private,
/// `spacetime generate` emits no bindings change and
/// `evals/baselines/table-schemas.json` records no index information — only the
/// unauthenticated schema endpoint publishes index METADATA, as it does for
/// every table, which discloses nothing beyond the column names already there.
/// Synthetic `chunk_id` PK: views strip primary keys, and
/// a `#[primary_key]`+`#[auto_inc]` column may carry no default, so the row
/// needs its own key. `request_id` is MINTED BY S4;
/// chunk-tuple uniqueness (owner, request, table, chunk_index)
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
    #[index(btree)]
    pub created_at_ms: i64,
}

/// One row per LIVE client connection: the host-minted
/// `ConnectionId` of the socket and the identity it authenticated as. Written
/// ONLY by the two lifecycle hooks in `lib.rs` (`on_connect` inserts,
/// `on_disconnect` deletes its own row) and erased by the deletion cascade;
/// read by `has_live_session`, which is what lets `on_disconnect` run the
/// trade, PvP, wild-battle and challenge force-resolves only when an
/// identity's LAST live connection ends — an ephemeral HTTP reducer call
/// (one connection per call) can no longer fire them under a live session.
/// PRIVATE: connection ids are per-session secrets in spirit and must never
/// leak through a subscription. Key shape is final on first ship:
/// the PK is the connection id (one row per socket, so a
/// re-entrant `client_connected` can never collide on identity), the btree
/// index on `identity` serves the sole reader. No timestamp column: a row left
/// behind by a crashed host self-heals when the launch replays
/// `client_disconnected` for every dangling `st_client` row. NOT covered: a
/// `client_disconnected` transaction that aborts AFTER its own-row delete rolls
/// that delete back while the host still drops the `st_client` row, and the
/// phantom then keeps `has_live_session` true for that identity (residual
/// still open; the mitigation path is an additive
/// `connected_at_ms` tail column + an idle-session reaper).
#[spacetimedb::table(accessor = player_session)]
pub struct PlayerSession {
    #[primary_key]
    pub connection_id: ConnectionId,
    #[index(btree)]
    pub identity: Identity,
}

/// Deletion policy for one table's rows at account-cascade time.
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

/// One table's data-lifecycle classification.
pub struct DataLifecycleEntry {
    /// The table's accessor name, exactly as declared in its table attribute.
    pub table: &'static str,
    /// What the deletion cascade does with this table's rows.
    pub policy: DeletionPolicy,
    /// Mandatory prose reason. NEVER put a slash in this string: the schema
    /// snapshot gate parses RAW source with a string-unaware comment stripper,
    /// so one comment delimiter inside a string literal silently truncates the
    /// parsed table set.
    pub basis: &'static str,
    /// Third, orthogonal axis: does `request_data_export` include this
    /// table? Export scope is structurally NARROWER than deletion scope.
    pub exportable: bool,
}

/// THE data-lifecycle manifest: exactly one entry per live
/// table. `accounts_tests.rs` compares this table set with the generated module
/// definition (`native_host_tests::Fixture::module_def`), so a new table cannot
/// silently retain personal data — adding a table without classifying it here
/// is a hard test failure, and a stale entry for a removed table is too.
///
/// Do not re-partition: add new tables with their own entry.
pub const DATA_LIFECYCLE_MANIFEST: &[DataLifecycleEntry] = &[
    // --- ERASE: rows deleted outright at cascade time.
    // ---
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
                of the TTL reaper (a row younger than its TTL must not survive \
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
    DataLifecycleEntry {
        table: "player_session",
        policy: DeletionPolicy::Erase,
        basis: "per-connection presence bookkeeping naming a live socket and its identity, erased with the presence rows at cascade time",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "pending_evolution_notice",
        policy: DeletionPolicy::Erase,
        basis: "transient delivery queue of unacknowledged evolution reveals, drained by the owner's own acks; ephemeral by design, not a durable history, so nothing to export",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_unit",
        policy: DeletionPolicy::Erase,
        basis: "deployed tactical unit of a battle the owner is a side of (owner is a sum type with no index), swept by battle id at cascade time; wild units have no owner and go with the battle; never exported because the transcript is GC-bound telemetry",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_queue",
        policy: DeletionPolicy::Erase,
        basis: "the owner READY plan, deleted outright at cascade time; the row is the design 6.3 secret and is never exported",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_deploy",
        policy: DeletionPolicy::Erase,
        basis: "the owner deploy staging, deleted outright at cascade time; never exported",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_clock",
        policy: DeletionPolicy::Erase,
        basis: "the per-side idle clock naming its player, deleted outright at cascade time; never exported",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "player_formation",
        policy: DeletionPolicy::Erase,
        basis: "the owner remembered deploy order, deleted outright at cascade time; re-keyed by the claim flow; never exported",
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
        basis: "ladder never-delete invariant: the ladder row survives and name is \
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
    DataLifecycleEntry {
        table: "battle_summary",
        policy: DeletionPolicy::Anonymize,
        basis: "per-battle telemetry (the H1 and H2 match-length source) survives with the deleting side identity column swapped to TOMBSTONE_IDENTITY, mirroring battle; never exported",
        exportable: false,
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
    DataLifecycleEntry {
        table: "battle_tactical",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; the per-battle tactical state keyed 1:1 by the anchor battle row and swept with it",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_secret",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; the RNG seed and roll counter (must never leak), swept via the owning battle row",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_wild_unit",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; per-wild individuality seeds (must never leak), swept via the owning battle row",
        exportable: false,
    },
    DataLifecycleEntry {
        table: "battle_event",
        policy: DeletionPolicy::ViaJoin("battle"),
        basis: "no Identity column; the execution transcript keyed by battle id, swept via the owning battle row ahead of the 24 h GC",
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
        basis: "one-shot deletion-grace schedule: armed only by the \
                account holder's own delete_account, disarmed by cancel, and the fired \
                row is deleted by the runtime itself — so no row survives the cascade \
                its own reducer runs, and an Erase entry would force the cascade to \
                disarm the very schedule whose reducer is running it",
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
        table: "export_bundle_reaper_schedule",
        policy: DeletionPolicy::NotOwned,
        basis: "global hourly TTL reaper schedule for the export_bundle table: an \
                interval singleton with no Identity column, armed by request_data_export \
                and by init and sync_content, never keyed to any player",
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
/// the `ViaJoin` payload) live in the lib target under `-D warnings`.
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
