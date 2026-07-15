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
    ActionState, Affinity, BattleState, Direction, MoveInput, NatureKind, StatKind, StatusKind,
};
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
    pub ability: Option<u32>, // additive (ADR-0006); None = no passive ability
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
#[spacetimedb::table(name = shop_row, public)]
pub struct ShopRow {
    #[primary_key]
    pub shop_id: u32,
    pub name: String,
}

/// Shop stock entries seeded from the `game-core` RON registry.
/// One row per (shop, item) pair. Looked up by shop_id index in the `buy` reducer.
/// Public (world-readable — shop prices are game content, not sensitive).
#[spacetimedb::table(name = shop_item_row, public)]
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
///
/// `opponent_identity` gains a btree index in M16a (ADR-0109) to support O(log n)
/// lookup in `forfeit_on_disconnect` for the case where the disconnecting player is
/// the opponent (side B).  Adding an index is additive (ADR-0006): no column or PK
/// change; the schema-snapshot eval tracks columns+PK only, not index presence.
#[derive(Clone)]
#[spacetimedb::table(name = battle, public)]
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
/// PRIVATE since M13.5c (ADR-0087): `npc_entity_id` + `current_node_id` leak
/// private quest/dialogue progress — clients read ONLY through the owner-scoped
/// `my_conversation` view below.
#[spacetimedb::table(name = player_conversation)]
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
#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &spacetimedb::ViewContext) -> Option<PlayerConversation> {
    ctx.db
        .player_conversation()
        .owner_identity()
        .find(ctx.sender)
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
#[spacetimedb::table(name = trade_offer, public)]
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
#[spacetimedb::table(name = player_wallet)]
pub struct PlayerWallet {
    #[primary_key]
    pub owner_identity: Identity,
    pub balance: u64,
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
#[spacetimedb::table(name = battle_challenge, public)]
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
/// no view, no RLS projection. The table is invisible to all clients; they
/// discover that a turn resolved by watching `battle.state.turn_number`
/// increment on their public `battle` subscription.
///
/// Two rows exist per turn (one per side); both are deleted atomically when
/// `resolve_pvp_turn_if_ready` fires in the same transaction.
#[spacetimedb::table(name = battle_action)]
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
