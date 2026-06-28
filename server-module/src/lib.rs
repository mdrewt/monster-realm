//! monster-realm server module (SpacetimeDB 2.6 / `spacetimedb` crate 1.12).
//!
//! The authoritative imperative shell: tables hold the world's truth; reducers are
//! the ONLY writers. Reducers are THIN — validate `ctx.sender` + legality, delegate
//! the rule to `game-core` (the SSOT `apply_move`), write tables; reject with `Err`,
//! never clamp. Movement is **server-paced and per-zone** (ADR-0011/0007): clients
//! buffer intent; a per-zone scheduled `movement_tick` drains one move/character/tick.
//! Time columns are `i64` ms (round-trip `game_core::Millis`). Syntax: crate 1.12.

use game_core::{
    apply_move, apply_xp_gain, battle_xp_reward, build_monster, derive_stats, load_encounters,
    load_items, load_skills, load_species, load_type_chart, recruit_chance, resolve_encounter,
    resolve_turn, roll_individuality, roll_starter, spawn, stepped_onto_grass, validate_content,
    validate_encounters, zone_0, ActionState, Affinity, BattleMonster, BattleOutcome, BattleSide,
    BattleState, CharacterState, Direction, EVs, EncounterEntry, EncounterTable, Level, Millis,
    MonsterInstance, MoveInput, NatureKind, SkillDef, StatBlock, StatKind, TileMap, TilePos,
    TurnChoice, TurnVariance, TypeChart, MOVE_QUEUE_CAP, RECRUIT_BASE_RATE, STEP_MS,
};
// SSOT helpers reached via their module path (not re-exported at the crate root
// in this slice's touch-set): the failed-recruit battle transition (which owns
// the turn-advance terminal) and the level-up HP-heal rule (ADR-0003).
use game_core::combat::{resolve::resolve_recruit_failure, xp::level_up_healed_hp};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

const ZONE_0: u32 = 0;
/// SSOT for the seeded-content version; bump when game-core RON content changes (ADR-0054).
const CONTENT_VERSION: u32 = 1;
const SPRITE_PLAYER: u32 = 0;
const MAX_NAME_LEN: usize = 24;
const MAX_PARTY_SIZE: u8 = game_core::PARTY_SIZE; // SSOT (ADR-0052)
const STARTER_SPECIES_ID: u32 = 1;

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

/// Per-zone movement schedule: one interval-row per active zone makes the
/// scheduler call `movement_tick` for THAT zone every `STEP_MS`.
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}

// --- Content tables (M6b, public, world-readable, module-write-only, ADR-0006) --

/// Species definitions seeded from the `game-core` RON registry by `sync_content`.
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
}

/// Public projection of the monster table — NO hidden fields (no IVs, EVs,
/// nature). Clients subscribe to this for the box/party view. Server writes
/// this alongside every `monster` mutation (dual-write discipline).
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

/// 255 sentinel = monster is in the box (not in any party slot).
const PARTY_SLOT_NONE: u8 = game_core::PARTY_SLOT_NONE; // SSOT (ADR-0052)

/// Zero-byte sentinel identity for the unowned wild opponent of a grass encounter
/// (ADR-0045). No real connection holds this identity, so a wild battle's
/// `opponent_identity` can never collide with a player's.
const WILD_IDENTITY: Identity = Identity::from_byte_array([0u8; 32]);

// --- Helpers (no game rules — pure marshaling) --------------------------------

fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000
}

fn log_reject(reducer: &str, sender: Identity, reason: &str) {
    log::warn!("{{\"evt\":\"reject\",\"reducer\":\"{reducer}\",\"sender\":\"{sender}\",\"reason\":\"{reason}\"}}");
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be at most {MAX_NAME_LEN} characters"));
    }
    if name.chars().any(char::is_control) {
        return Err("name contains invalid characters".to_string());
    }
    Ok(name.to_string())
}

/// The map for a zone (M2: one authored zone; `map_for(zone_id)` generalizes at M11).
fn zone_map(_zone_id: u32) -> TileMap {
    // M2 has exactly one authored zone. A second active zone needs a real
    // `map_for(zone_id)` (M11); fail loud in dev/CI if a non-zero zone tick ever
    // reaches here rather than silently moving everyone on zone 0's map.
    // (`_zone_id`: `debug_assert` is stripped in release, so keep it warning-free.)
    debug_assert_eq!(_zone_id, ZONE_0, "zone_map: only zone_0 exists until M11");
    zone_0()
}

// `convert` seam: flatten `game-core::CharacterState` <-> `character` columns. The
// shared type stays the SSOT while the table stays queryable. Intentionally
// repetitive — DRY does not cross the marshaling boundary.
fn char_state(row: &Character) -> CharacterState {
    CharacterState {
        pos: TilePos {
            x: row.tile_x,
            y: row.tile_y,
        },
        facing: row.facing,
        action: row.action,
        move_started_at: Millis(row.move_started_at_ms),
    }
}

fn apply_state(row: &mut Character, next: &CharacterState) {
    row.tile_x = next.pos.x;
    row.tile_y = next.pos.y;
    row.facing = next.facing;
    row.action = next.action;
    row.move_started_at_ms = next.move_started_at.0;
}

// `convert` seam: flatten `game-core::MonsterInstance` -> `Monster` table row.
// Intentionally repetitive — DRY does not cross the marshaling boundary.
fn monster_from_instance(owner: Identity, inst: &MonsterInstance, party_slot: u8) -> Monster {
    Monster {
        monster_id: 0, // auto_inc
        owner_identity: owner,
        species_id: inst.species_id,
        nickname: inst.nickname.clone().unwrap_or_default(),
        level: inst.level.as_u8(),
        xp: inst.xp.value(),
        bond: inst.bond.value(),
        iv_hp: inst.ivs.get(StatKind::Hp),
        iv_attack: inst.ivs.get(StatKind::Attack),
        iv_defense: inst.ivs.get(StatKind::Defense),
        iv_speed: inst.ivs.get(StatKind::Speed),
        iv_sp_attack: inst.ivs.get(StatKind::SpAttack),
        iv_sp_defense: inst.ivs.get(StatKind::SpDefense),
        nature_kind: inst.nature.kind(),
        ev_hp: inst.evs.get(StatKind::Hp),
        ev_attack: inst.evs.get(StatKind::Attack),
        ev_defense: inst.evs.get(StatKind::Defense),
        ev_speed: inst.evs.get(StatKind::Speed),
        ev_sp_attack: inst.evs.get(StatKind::SpAttack),
        ev_sp_defense: inst.evs.get(StatKind::SpDefense),
        stat_hp: inst.derived_stats.hp,
        stat_attack: inst.derived_stats.attack,
        stat_defense: inst.derived_stats.defense,
        stat_speed: inst.derived_stats.speed,
        stat_sp_attack: inst.derived_stats.sp_attack,
        stat_sp_defense: inst.derived_stats.sp_defense,
        current_hp: inst.current_hp,
        party_slot,
    }
}

// `convert` seam: flatten `game-core::EncounterTable` -> private `EncounterRow`.
// No `ctx` — pure marshaling. `Level` flattens to `u8` (like `Millis` -> `i64`).
fn encounter_rows_from_table(table: &game_core::EncounterTable) -> EncounterRow {
    EncounterRow {
        zone_id: table.zone_id,
        encounter_rate: table.encounter_rate,
        entries: table
            .entries
            .iter()
            .map(|e| EncounterEntryRow {
                species_id: e.species_id,
                weight: e.weight,
                min_level: e.min_level.as_u8(),
                max_level: e.max_level.as_u8(),
            })
            .collect(),
    }
}

// `convert` seam: inverse of `encounter_rows_from_table` — rebuild the pure
// `game_core::EncounterTable` from the private `EncounterRow` so the grass/manual
// paths can call `resolve_encounter` (the SSOT trigger decision). Pure, no `ctx`.
fn table_from_encounter_row(row: &EncounterRow) -> Result<EncounterTable, String> {
    let mut entries = Vec::with_capacity(row.entries.len());
    for e in &row.entries {
        entries.push(EncounterEntry {
            species_id: e.species_id,
            weight: e.weight,
            min_level: Level::new(e.min_level)?,
            max_level: Level::new(e.max_level)?,
        });
    }
    Ok(EncounterTable {
        zone_id: row.zone_id,
        encounter_rate: row.encounter_rate,
        entries,
    })
}

/// Build a wild `BattleMonster` (no owned `monster` row) from a species, the
/// server-loaded skill ids, a level, and the individuality seed (M8c, ADR-0045).
/// PURE / deterministic in `seed` — no `ctx`. Full-HP, EVs zero; IVs+nature come
/// from `roll_individuality(seed)` and stats from `derive_stats`, so the stored
/// seed rebuilds THIS exact wild in M8d. `known_skill_ids` = the species'
/// `learnable_skill_ids` intersected with `skill_ids`, iterated in learnable order
/// (so `[1,2,3] ∩ [2,3,9] == [2,3]`). An out-of-range `level` is a loud `Err`,
/// never a panic.
fn wild_battle_monster(
    species: &SpeciesRow,
    skill_ids: &[u32],
    level: u8,
    seed: u32,
) -> Result<BattleMonster, String> {
    let lvl = Level::new(level)?;
    let (ivs, nature) = roll_individuality(seed);
    let evs = EVs::zero();
    let base = StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    let stats = derive_stats(&base, &ivs, &evs, &nature, lvl);
    let known_skill_ids: Vec<u32> = species
        .learnable_skill_ids
        .iter()
        .copied()
        .filter(|id| skill_ids.contains(id))
        .collect();
    Ok(BattleMonster {
        species_id: species.id,
        affinity: species.affinity,
        level,
        current_hp: stats.hp,
        max_hp: stats.hp,
        stats,
        known_skill_ids,
    })
}

/// Derive the public projection from a private monster row. No hidden fields.
fn pub_from_monster(m: &Monster) -> MonsterPub {
    MonsterPub {
        monster_id: m.monster_id,
        owner_identity: m.owner_identity,
        species_id: m.species_id,
        nickname: m.nickname.clone(),
        level: m.level,
        xp: m.xp,
        bond: m.bond,
        current_hp: m.current_hp,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        party_slot: m.party_slot,
    }
}

// --- Battle helpers (M7b, pure marshaling — no ctx) ---------------------------

/// Marshal a Monster row + its species + its known skills into a BattleMonster.
///
/// Trust boundary (ADR-0049, reject-not-clamp): a row with `stat_defense == 0`
/// is rejected with `Err` rather than passed into the pure core, where it would
/// divide-by-zero in `calc_damage`.
fn battle_monster_from_row(
    monster: &Monster,
    species: &SpeciesRow,
    skills: &[SkillRow],
) -> Result<BattleMonster, String> {
    if monster.stat_defense == 0 {
        return Err(format!(
            "monster {} has stat_defense 0 (illegal: would divide-by-zero in calc_damage)",
            monster.monster_id
        ));
    }
    Ok(BattleMonster {
        species_id: monster.species_id,
        affinity: species.affinity,
        level: monster.level,
        current_hp: monster.current_hp,
        max_hp: monster.stat_hp,
        stats: StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: skills.iter().map(|s| s.id).collect(),
    })
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row.
fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp;
}

/// Sum the six base stats of a species (for the XP formula).
///
/// Pure marshaling (ADR-0049): the base-stat-total definition is owned by the
/// rule layer (`game_core::base_stat_total`, SSOT). This shell only builds a
/// `StatBlock` from the species row's six `base_*` columns and delegates.
fn loser_base_stat_total(species: &SpeciesRow) -> u16 {
    let base = game_core::StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    game_core::base_stat_total(&base)
}

/// Build a `Vec<SkillDef>` from the DB skill rows for the resolver.
fn skill_defs_from_rows(rows: &[SkillRow]) -> Vec<SkillDef> {
    rows.iter()
        .map(|r| SkillDef {
            id: r.id,
            name: r.name.clone(),
            affinity: r.affinity,
            power: r.power,
            accuracy: r.accuracy,
            pp: r.pp,
        })
        .collect()
}

/// Build the type chart from DB rows.
fn type_chart_from_rows(rows: impl Iterator<Item = TypeRelationRow>) -> TypeChart {
    let rels: Vec<game_core::TypeRelation> = rows
        .map(|r| game_core::TypeRelation {
            attacker: r.attacker,
            defender: r.defender,
            effectiveness: r.effectiveness,
        })
        .collect();
    game_core::TypeChart::new(&rels)
}

fn sync_content_inner(ctx: &ReducerContext) {
    // Re-derive only when the stored content version is stale (ADR-0054). A
    // redundant sync_content with a current version is a no-op.
    if let Some(cfg) = ctx.db.config().id().find(0) {
        if cfg.content_version == CONTENT_VERSION {
            return;
        }
    }
    let zones = match game_core::load_zones() {
        Ok(z) => z,
        Err(e) => {
            log::error!("{{\"evt\":\"sync_content_error\",\"reason\":\"{e}\"}}");
            return;
        }
    };
    if let Err(e) = game_core::validate_zones(&zones) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }
    for z in &zones {
        match ctx.db.zone_def().zone_id().find(z.id) {
            Some(existing) => {
                if existing.name != z.name
                    || existing.width != z.width
                    || existing.height != z.height
                {
                    ctx.db.zone_def().zone_id().update(ZoneDefRow {
                        zone_id: z.id,
                        name: z.name.clone(),
                        width: z.width,
                        height: z.height,
                    });
                }
            }
            None => {
                ctx.db.zone_def().insert(ZoneDefRow {
                    zone_id: z.id,
                    name: z.name.clone(),
                    width: z.width,
                    height: z.height,
                });
            }
        }
    }

    // --- M6b content: species, skills, type chart, items ---
    let species = match load_species() {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"species\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let skills = match load_skills() {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"skills\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let type_chart = match load_type_chart() {
        Ok(t) => t,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"type_chart\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let items = match load_items() {
        Ok(i) => i,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"items\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    if let Err(e) = validate_content(&species, &skills, &type_chart, &items) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }

    for sp in &species {
        let row = SpeciesRow {
            id: sp.id,
            name: sp.name.clone(),
            base_hp: sp.base_stats.hp,
            base_attack: sp.base_stats.attack,
            base_defense: sp.base_stats.defense,
            base_speed: sp.base_stats.speed,
            base_sp_attack: sp.base_stats.sp_attack,
            base_sp_defense: sp.base_stats.sp_defense,
            affinity: sp.affinity,
            learnable_skill_ids: sp.learnable_skill_ids.clone(),
        };
        match ctx.db.species_row().id().find(sp.id) {
            Some(_) => {
                ctx.db.species_row().id().update(row);
            }
            None => {
                ctx.db.species_row().insert(row);
            }
        }
    }
    for sk in &skills {
        let row = SkillRow {
            id: sk.id,
            name: sk.name.clone(),
            affinity: sk.affinity,
            power: sk.power,
            accuracy: sk.accuracy,
            pp: sk.pp,
        };
        match ctx.db.skill_row().id().find(sk.id) {
            Some(_) => {
                ctx.db.skill_row().id().update(row);
            }
            None => {
                ctx.db.skill_row().insert(row);
            }
        }
    }
    // Type chart: clear and re-insert (no stable PK; the logical key is the pair).
    for existing in ctx.db.type_relation_row().iter().collect::<Vec<_>>() {
        ctx.db.type_relation_row().id().delete(existing.id);
    }
    for rel in &type_chart {
        ctx.db.type_relation_row().insert(TypeRelationRow {
            id: 0, // auto_inc
            attacker: rel.attacker,
            defender: rel.defender,
            effectiveness: rel.effectiveness,
        });
    }
    for item in &items {
        let row = ItemRow {
            id: item.id,
            name: item.name.clone(),
            description: item.description.clone(),
            recruit_bonus: item.recruit_bonus,
        };
        match ctx.db.item_row().id().find(item.id) {
            Some(_) => {
                ctx.db.item_row().id().update(row);
            }
            None => {
                ctx.db.item_row().insert(row);
            }
        }
    }

    // --- M8b encounter tables (PRIVATE; ADR-0040 must-never-leak) ---
    // Validate BEFORE any write so a bad registry never wipes/partially seeds.
    let encounters = match load_encounters() {
        Ok(e) => e,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"encounters\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    if let Err(e) = validate_encounters(&encounters, &species, &zones) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }
    for table in &encounters {
        let row = encounter_rows_from_table(table);
        match ctx.db.encounter().zone_id().find(table.zone_id) {
            Some(_) => {
                ctx.db.encounter().zone_id().update(row);
            }
            None => {
                ctx.db.encounter().insert(row);
            }
        }
    }

    // Stamp the now-current content version so a later redundant sync_content
    // short-circuits at the top of this function (ADR-0054). A missing config row
    // here is an invariant violation (init always inserts it) — fail loud, don't
    // silently skip, consistent with this function's other error logging.
    match ctx.db.config().id().find(0) {
        Some(mut cfg) => {
            cfg.content_version = CONTENT_VERSION;
            ctx.db.config().id().update(cfg);
        }
        None => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"reason\":\"config row missing at stamp\"}}"
            );
        }
    }
}

/// Shared ownership + monotonic-seq guard for the move reducers. Returns the
/// owned character row on success.
fn authorize_move(ctx: &ReducerContext, reducer: &str, seq: u64) -> Result<Character, String> {
    let me = ctx.sender;
    let Some(mut player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    if seq <= player.last_input_seq {
        let e = "stale seq".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    let Some(ch) = ctx.db.character().entity_id().find(player.entity_id) else {
        let e = "no character".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    // Accept-time ack: record receipt the moment intent is accepted (not applied).
    // ADR-0052: this ack is safe to write here even though `enqueue_move` may still
    // reject an over-cap queue with `Err("queue full")` AFTER this returns Ok — that
    // Err rolls the WHOLE SpacetimeDB transaction back (including this update), so
    // "ack only on a successful enqueue" holds by transaction semantics. Do not split
    // the ack out of `authorize_move` to "fix" this (the rollback already guarantees it).
    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(ch)
}

// --- Reducers -----------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        // Unseeded sentinel (0 != CONTENT_VERSION) so sync_content_inner ALWAYS
        // seeds on first init; the early-return only fires on a redundant re-sync.
        content_version: 0,
    });
    sync_content_inner(ctx);
    // One schedule row per initial zone (M2: zone 0).
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id: ZONE_0,
            scheduled_at: ScheduleAt::Interval(
                Duration::from_millis(STEP_MS.unsigned_abs()).into(),
            ),
        });
    log::info!(
        "{{\"evt\":\"init\",\"zones\":{}}}",
        ctx.db.zone_def().iter().count()
    );
}

#[spacetimedb::reducer]
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("sync_content is module-only".to_string());
    }
    sync_content_inner(ctx);
    Ok(())
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender;
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.character().entity_id().delete(p.entity_id);
        ctx.db.player().identity().delete(me);
    }
}

/// Join: one `player` + one `character` at the spawn + one starter `monster`
/// (idempotent: a returning player gets character+player only, not a second
/// monster). Rejects a double-join within the same session.
#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let me = ctx.sender;
    let name = validate_name(&name).inspect_err(|e| log_reject("join_game", me, e))?;
    if ctx.db.player().identity().find(me).is_some() {
        let e = "already joined".to_string();
        log_reject("join_game", me, &e);
        return Err(e);
    }
    let sp = spawn();
    let ch = ctx.db.character().insert(Character {
        entity_id: 0,
        zone_id: ZONE_0,
        tile_x: sp.x,
        tile_y: sp.y,
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at_ms: now_ms(ctx),
        sprite_id: SPRITE_PLAYER,
        move_queue: Vec::new(),
    });
    ctx.db.player().insert(Player {
        identity: me,
        entity_id: ch.entity_id,
        name,
        online: true,
        last_input_seq: 0,
    });

    // Grant starter if this identity has no monsters yet (idempotent on reconnect).
    let has_monsters = ctx
        .db
        .monster()
        .owner_identity()
        .filter(me)
        .next()
        .is_some();
    if !has_monsters {
        let Some(species) = ctx.db.species_row().id().find(STARTER_SPECIES_ID) else {
            let e =
                format!("starter species {STARTER_SPECIES_ID} not found — content sync required");
            log_reject("join_game", me, &e);
            return Err(e);
        };
        let species_core = game_core::Species {
            id: species.id,
            name: species.name.clone(),
            base_stats: StatBlock {
                hp: species.base_hp,
                attack: species.base_attack,
                defense: species.base_defense,
                speed: species.base_speed,
                sp_attack: species.base_sp_attack,
                sp_defense: species.base_sp_defense,
            },
            affinity: species.affinity,
            learnable_skill_ids: species.learnable_skill_ids.clone(),
        };
        let seed: u32 = ctx.random();
        let inst = roll_starter(seed, &species_core);
        let row = monster_from_instance(me, &inst, 0); // party slot 0
        let inserted = ctx.db.monster().insert(row);
        ctx.db.monster_pub().insert(pub_from_monster(&inserted));
        log::info!(
            "{{\"evt\":\"starter_granted\",\"sender\":\"{me}\",\"monster_id\":{}}}",
            inserted.monster_id
        );
    }

    log::info!("{{\"evt\":\"join\",\"sender\":\"{me}\"}}");
    Ok(())
}

/// Append one intent to the bounded queue (anti-flood: reject when full). Buffers
/// intent only — NEVER computes movement. Atomic: queue + ack in one transaction.
#[spacetimedb::reducer]
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "enqueue_move", seq)?;
    if ch.move_queue.len() >= MOVE_QUEUE_CAP {
        let e = "queue full".to_string();
        log_reject("enqueue_move", ctx.sender, &e);
        return Err(e);
    }
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Replace the ENTIRE undrained queue with one input (a responsive turn/direction
/// change). Cap-safe (length 1).
#[spacetimedb::reducer]
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "set_move", seq)?;
    ch.move_queue.clear();
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Empty the queue (key release).
#[spacetimedb::reducer]
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "clear_queue", seq)?;
    ch.move_queue.clear();
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Per-zone, server-paced tick: drain ≤1 move per character in THIS zone, compute
/// the outcome via `game_core::apply_move`, write back. Scheduler-only.
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;
    let now = Millis(now_ms(ctx));
    let map = zone_map(zone);
    // Snapshot ids BEFORE mutating (never mutate the table mid-iteration).
    let ids: Vec<u64> = ctx
        .db
        .character()
        .zone_id()
        .filter(zone)
        .map(|c| c.entity_id)
        .collect();
    for id in ids {
        let Some(mut row) = ctx.db.character().entity_id().find(id) else {
            continue;
        };
        if row.move_queue.is_empty() {
            if row.action != ActionState::Idle {
                row.action = ActionState::Idle;
                ctx.db.character().entity_id().update(row);
            }
            continue;
        }
        let input = row.move_queue.remove(0);
        let prev = char_state(&row).pos; // capture BEFORE apply_move
        let next = apply_move(&char_state(&row), input, &map, now);
        apply_state(&mut row, &next);
        // position + drained move_queue written in ONE update (atomic, ADR-0013 §B).
        let entity_id = row.entity_id;
        ctx.db.character().entity_id().update(row);

        // M8c grass-encounter trigger (ADR-0045). EVERY failure mode below is a
        // no-op, never a panic. Draw `ctx.random()` AT MOST once per character —
        // only after `stepped_onto_grass` + player + not-already-in-battle pass —
        // so A's hit cannot shift B's roll in the same tick (R-E).
        if !stepped_onto_grass(prev, next.pos, &map) {
            continue;
        }
        // Player-only: an NPC character has no `player` row → no encounter.
        let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
            continue;
        };
        let player_identity = player.identity;
        let already = ctx
            .db
            .battle()
            .player_identity()
            .filter(player_identity)
            .any(|b| b.state.outcome == BattleOutcome::Ongoing);
        if already {
            continue;
        }
        // Lead party level (no party → no-op). begin_encounter's empty-party guard
        // is the backstop.
        let Some((party_ids, player_level)) = lead_party(ctx, player_identity) else {
            continue;
        };
        // The zone's PRIVATE encounter table (partial-sync: missing row → no-op).
        let Some(enc_row) = ctx.db.encounter().zone_id().find(zone) else {
            continue;
        };
        let Ok(table) = table_from_encounter_row(&enc_row) else {
            continue;
        };
        let seed: u32 = ctx.random();
        if let Some(w) = resolve_encounter(&table, seed, player_level) {
            // A failed begin_encounter is a no-op (logged inside on the happy path);
            // swallow the Err so one character's encounter cannot abort the tick.
            let _ = begin_encounter(
                ctx,
                player_identity,
                party_ids,
                w.species_id,
                w.level.as_u8(),
                w.individuality_seed,
            );
        }
    }
    Ok(())
}

// --- Monster management reducers (M6b) ----------------------------------------

/// Set or clear a monster's nickname. Empty string clears the nickname.
/// Ownership-checked: only the monster's owner may rename it.
#[spacetimedb::reducer]
pub fn set_nickname(ctx: &ReducerContext, monster_id: u64, nickname: String) -> Result<(), String> {
    let me = ctx.sender;
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_nickname", me, &e);
        return Err(e);
    };
    if m.owner_identity != me {
        let e = "not owner".to_string();
        log_reject("set_nickname", me, &e);
        return Err(e);
    }
    let validated = if nickname.trim().is_empty() {
        String::new() // clear nickname
    } else {
        validate_name(&nickname).inspect_err(|e| log_reject("set_nickname", me, e))?
    };
    m.nickname = validated;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

/// Set or clear a monster's party slot. `slot = 255` moves to box; `slot < 6`
/// assigns a party position. Ownership-checked; rejects out-of-range slots and
/// occupied-slot conflicts (caller must clear the existing occupant first).
#[spacetimedb::reducer]
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String> {
    let me = ctx.sender;
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    };
    if m.owner_identity != me {
        let e = "not owner".to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    }
    if slot != PARTY_SLOT_NONE && slot >= MAX_PARTY_SIZE {
        let e =
            format!("slot {slot} out of range (0..{MAX_PARTY_SIZE} or {PARTY_SLOT_NONE} for box)");
        log_reject("set_party_slot", me, &e);
        return Err(e);
    }
    // If assigning to a party slot, check it's not already occupied.
    if slot != PARTY_SLOT_NONE {
        let occupied = ctx
            .db
            .monster()
            .owner_identity()
            .filter(me)
            .any(|other| other.monster_id != monster_id && other.party_slot == slot);
        if occupied {
            let e = format!("party slot {slot} already occupied");
            log_reject("set_party_slot", me, &e);
            return Err(e);
        }
    }
    m.party_slot = slot;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

// --- Battle reducers (M7b) ---------------------------------------------------

// --- Battle-input validators (M8.5a, ADR-0048) -------------------------------
// Pure, total predicates over the trust boundary. Extracted so the rejection
// rules are unit-testable without a ReducerContext and reused by `start_battle`
// and the write-back path. Every illegal input is an `Err` — reject-not-clamp.

/// Caller party size must be in `1..=MAX_PARTY_SIZE` (empty is invalid; an
/// oversized list is rejected, never truncated). The SSOT party-size validator.
fn check_party_size(n: usize) -> Result<(), String> {
    if n == 0 {
        return Err("party must contain at least one monster".to_string());
    }
    if n > usize::from(MAX_PARTY_SIZE) {
        return Err(format!(
            "party size {n} exceeds MAX_PARTY_SIZE ({MAX_PARTY_SIZE})"
        ));
    }
    Ok(())
}

/// A monster offered to a battle must be party-slotted, not boxed
/// (`party_slot == PARTY_SLOT_NONE`). Boxed monsters cannot be conscripted.
fn check_monster_in_party(slot: u8) -> Result<(), String> {
    if slot == PARTY_SLOT_NONE {
        return Err("monster is boxed (not party-slotted)".to_string());
    }
    Ok(())
}

/// The positional coupling the write-back path relies on: `side_a.team[i]`
/// pairs with `party_monster_ids[i]`. A length mismatch is an illegal state —
/// return `Err` (the caller surfaces it) rather than panic-indexing.
fn check_team_coupling(team_len: usize, ids_len: usize) -> Result<(), String> {
    if team_len != ids_len {
        return Err(format!(
            "battle invariant violated: side_a.team.len() ({team_len}) != party_monster_ids.len() ({ids_len})"
        ));
    }
    Ok(())
}

/// Start a PvE battle: build BattleMonsters from the player's party and the
/// opponent's party (owned by opponent_identity), create a BattleState, insert
/// the Battle row. Both parties must have at least one conscious party member.
///
/// Opponent provenance (ADR-0048): only a self/sandbox opponent
/// (`opponent_identity == ctx.sender`) or the server/NPC sentinel
/// (`WILD_IDENTITY`) is accepted. A client may NOT name another player as the
/// opponent — that would conscript their monsters into the public `battle` row.
#[spacetimedb::reducer]
pub fn start_battle(
    ctx: &ReducerContext,
    opponent_identity: Identity,
    party_monster_ids: Vec<u64>,
    opponent_monster_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender;

    // Bound BOTH parties to 1..=MAX_PARTY_SIZE (reject empty AND oversized —
    // never truncate; an unbounded list is N species lookups + N skill scans +
    // N row writes, and would yield a side with team.len() > MAX_PARTY_SIZE).
    // These pure O(1) checks run BEFORE the O(N) dedup scan and any DB read so a
    // huge list can't exhaust memory pre-rejection. M8.5a.
    if let Err(e) = check_party_size(party_monster_ids.len()) {
        log_reject("start_battle", me, &e);
        return Err(e);
    }
    if let Err(e) = check_party_size(opponent_monster_ids.len()) {
        let e = format!("opponent {e}");
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Opponent-provenance authorization (ADR-0048): accept ONLY self/sandbox
    // (opponent_identity == ctx.sender) or the server/NPC sentinel
    // (WILD_IDENTITY). Naming another player would conscript their monsters into
    // the public `battle` row (info-leak / grief / XP farm). Reject before the
    // dedup scan and any side-B DB read so a foreign roster never reaches the
    // row. reject-not-clamp.
    if opponent_identity != me && opponent_identity != WILD_IDENTITY {
        let e = "opponent must be self or server-authored (PvP unsupported; ADR-0048)".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Reject duplicate monster IDs across both sides (prevents double XP
    // write-back / a monster fighting itself). Both lists are now bounded by
    // MAX_PARTY_SIZE, so this scan is O(1)-bounded.
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_monster_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in party_monster_ids");
                log_reject("start_battle", me, &e);
                return Err(e);
            }
        }
        for &mid in &opponent_monster_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in opponent_monster_ids");
                log_reject("start_battle", me, &e);
                return Err(e);
            }
        }
    }

    // Check caller is not already in an ongoing battle.
    let already_in_battle = ctx
        .db
        .battle()
        .player_identity()
        .filter(me)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already_in_battle {
        let e = "already in an ongoing battle".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Build side A (player) team.
    let mut team_a = Vec::new();
    for &mid in &party_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("party monster {mid} not found"))?;
        if m.owner_identity != me {
            let e = format!("monster {mid} not owned by caller");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        // Reject boxed monsters — only party-slotted monsters may battle (M8.5a).
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("monster {mid} {e}");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_a.push(battle_monster_from_row(&m, &sp, &skills)?);
    }

    // Build side B (opponent) team.
    let mut team_b = Vec::new();
    for &mid in &opponent_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("opponent monster {mid} not found"))?;
        if m.owner_identity != opponent_identity {
            let e = format!("monster {mid} not owned by opponent");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        // Reject boxed monsters on side-B too — a boxed monster's derived stats
        // must not be embedded into the public `battle` row (M8.5a).
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("opponent monster {mid} {e}");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_b.push(battle_monster_from_row(&m, &sp, &skills)?);
    }

    // At least one conscious monster per side.
    if !team_a.iter().any(|m| !m.is_fainted()) {
        let e = "party has no conscious monster".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }
    if !team_b.iter().any(|m| !m.is_fainted()) {
        let e = "opponent has no conscious monster".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    let state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: team_a,
        },
        side_b: BattleSide {
            active: 0,
            team: team_b,
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    };

    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: me,
        opponent_identity,
        state,
        party_monster_ids,
        opponent_monster_ids,
        created_at_ms: now_ms(ctx),
    });

    log::info!(
        "{{\"evt\":\"battle_start\",\"battle_id\":{},\"sender\":\"{me}\"}}",
        battle.battle_id
    );
    Ok(())
}

// --- Wild encounter (M8c, ADR-0045) -------------------------------------------

/// The player's lead party monster (lowest `party_slot`) ids + level. Returns
/// `(party_ids, lead_level)` over ALL party monsters (slot != 255), ordered by
/// slot. `None` if the player has no party monster (callers treat that as a no-op
/// / `Err`, and `begin_encounter`'s empty-party guard is the backstop).
fn lead_party(ctx: &ReducerContext, owner: Identity) -> Option<(Vec<u64>, Level)> {
    let mut party: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .filter(|m| m.party_slot != PARTY_SLOT_NONE)
        .collect();
    party.sort_by_key(|m| m.party_slot);
    let lead = party.first()?;
    let lead_level = Level::new(lead.level).ok()?;
    let ids = party.iter().map(|m| m.monster_id).collect();
    Some((ids, lead_level))
}

/// Begin a wild battle: build side A from the player's owned party and side B from
/// a single freshly-rolled wild (no owned `monster` row). Builds the `Battle` row
/// DIRECTLY (NOT via `start_battle`, so `start_battle`'s owned-opponent guards stay
/// intact) and inserts the private `battle_wild` row (1:1). Returns the new
/// `battle_id`. Carries ALL of `start_battle`'s guards (R-D). EVERY rejection is an
/// `Err`, never a panic.
fn begin_encounter(
    ctx: &ReducerContext,
    player_identity: Identity,
    party_monster_ids: Vec<u64>,
    wild_species_id: u32,
    wild_level: u8,
    individuality_seed: u32,
) -> Result<u64, String> {
    if party_monster_ids.is_empty() {
        return Err("party_monster_ids must not be empty".to_string());
    }
    // Reject duplicate party ids (double-XP guard, like start_battle).
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_monster_ids {
            if !seen.insert(mid) {
                return Err(format!("duplicate monster_id {mid} in party_monster_ids"));
            }
        }
    }
    // Reject if the player is already in an ongoing battle.
    let already_in_battle = ctx
        .db
        .battle()
        .player_identity()
        .filter(player_identity)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already_in_battle {
        return Err("already in an ongoing battle".to_string());
    }

    // Build side A (player) from the owned party.
    let mut team_a = Vec::new();
    for &mid in &party_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("party monster {mid} not found"))?;
        if m.owner_identity != player_identity {
            return Err(format!("monster {mid} not owned by player"));
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_a.push(battle_monster_from_row(&m, &sp, &skills)?);
    }
    if !team_a.iter().any(|m| !m.is_fainted()) {
        return Err("party has no conscious monster".to_string());
    }

    // Build side B: exactly ONE wild monster (no owned monster row). The species
    // must exist at creation (R-G): a battle created after `sync_content` cannot
    // miss it on the M8d win-path lookup.
    let sp = ctx
        .db
        .species_row()
        .id()
        .find(wild_species_id)
        .ok_or_else(|| format!("wild species {wild_species_id} not found"))?;
    let skill_ids: Vec<u32> = ctx
        .db
        .skill_row()
        .iter()
        .filter(|s| sp.learnable_skill_ids.contains(&s.id))
        .map(|s| s.id)
        .collect();
    let wild = wild_battle_monster(&sp, &skill_ids, wild_level, individuality_seed)?;

    let state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: team_a,
        },
        // ASYMMETRY (documented for M8d): `side_b.team.len() == 1` (the wild, so
        // `side_b.active_monster()` never indexes an empty team), but
        // `opponent_monster_ids.len() == 0` (the wild is UNOWNED — no monster row).
        // Do NOT zip these two: side_b has a BattleMonster but no backing id.
        side_b: BattleSide {
            active: 0,
            team: vec![wild],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    };

    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity,
        opponent_identity: WILD_IDENTITY,
        state,
        party_monster_ids,
        opponent_monster_ids: vec![],
        created_at_ms: now_ms(ctx),
    });

    ctx.db.battle_wild().insert(BattleWild {
        battle_id: battle.battle_id,
        wild_species_id,
        wild_level,
        individuality_seed,
    });

    // Log ONLY the public coordinates — NEVER the seed / IVs / nature (side-channel).
    log::info!(
        "{{\"evt\":\"wild_encounter\",\"battle_id\":{},\"wild_species_id\":{wild_species_id},\"wild_level\":{wild_level}}}",
        battle.battle_id
    );
    Ok(battle.battle_id)
}

/// DEV/TEST entrypoint (gate or remove at M9+): a faithful double of the grass
/// path, since `movement_tick` is scheduler-only. Validates the sender joined +
/// has a party + is not already in a battle, draws the encounter seed SERVER-side
/// (`ctx.random()`, NO client-supplied seed → no IV-grind cheat surface), rolls
/// species/level from the zone's PRIVATE `encounter` table exactly like the grass
/// path, and calls `begin_encounter`. A missing encounter row or a no-trigger roll
/// is a no-op `Err` (never a panic).
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    // Must be joined (has a player + character).
    let Some(player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        let e = "no character".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    // Reject a spoofed zone BEFORE any party DB work: the encounter is rolled from
    // the caller's OWN zone, never a client-named arbitrary zone (reject-not-clamp).
    if zone_id != character.zone_id {
        let e = format!(
            "zone mismatch: arg {zone_id} != character zone {}",
            character.zone_id
        );
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    }
    // Must have a party.
    let Some((party_ids, player_level)) = lead_party(ctx, me) else {
        let e = "no party monster".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    // Not already in a battle (begin_encounter re-checks; this gives a clear error).
    let already = ctx
        .db
        .battle()
        .player_identity()
        .filter(me)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already {
        let e = "already in an ongoing battle".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    }
    // The zone's PRIVATE encounter table, keyed by the SERVER-authoritative
    // character.zone_id (not the raw client arg) — defense-in-depth so the lookup
    // never trusts the client even if the reject check above is later reordered
    // (MED-1, ADR-0054 §3). (partial-sync: missing row → Err no-op.)
    let Some(row) = ctx.db.encounter().zone_id().find(character.zone_id) else {
        let e = format!("no encounter table for zone {}", character.zone_id);
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    let table = table_from_encounter_row(&row)?;
    let seed: u32 = ctx.random();
    let Some(w) = resolve_encounter(&table, seed, player_level) else {
        let e = "no encounter triggered".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    begin_encounter(
        ctx,
        me,
        party_ids,
        w.species_id,
        w.level.as_u8(),
        w.individuality_seed,
    )?;
    Ok(())
}

/// Submit an attack: resolve one turn where the player attacks with `skill_id`
/// and the opponent uses AI. Ownership + outcome guards enforced.
#[spacetimedb::reducer]
pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("submit_attack", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("submit_attack", me, &e);
        return Err(e);
    }

    // Validate skill_id is in the active monster's moveset.
    let active_skills = &battle.state.side_a.active_monster().known_skill_ids;
    if !active_skills.contains(&skill_id) {
        let e = format!("skill {skill_id} not in active monster's moveset");
        log_reject("submit_attack", me, &e);
        return Err(e);
    }

    // Load skills and type chart for the resolver.
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());

    // AI picks a skill for side B.
    let enemy_skill_id = game_core::pick_best_skill(
        battle.state.side_b.active_monster(),
        battle.state.side_a.active_monster(),
        &skill_defs,
        &type_chart,
    );

    let _events = resolve_turn(
        &mut battle.state,
        TurnChoice::Attack { skill_id },
        TurnChoice::Attack {
            skill_id: enemy_skill_id,
        },
        &skill_defs,
        &type_chart,
        &variance,
    );

    // Write back HP + XP if battle ended.
    if battle.state.outcome != BattleOutcome::Ongoing {
        write_back_battle_results(ctx, &battle)?;
    }

    ctx.db.battle().battle_id().update(battle);
    Ok(())
}

/// Swap the player's active monster. Ownership + outcome guards enforced.
#[spacetimedb::reducer]
pub fn swap_active(ctx: &ReducerContext, battle_id: u64, team_index: u32) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    let idx = team_index as usize;
    if idx >= battle.state.side_a.team.len() {
        let e = format!("team_index {team_index} out of bounds");
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    if battle.state.side_a.team[idx].is_fainted() {
        let e = format!("monster at index {team_index} is fainted");
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    if battle.state.side_a.active == team_index {
        let e = "already the active monster".to_string();
        log_reject("swap_active", me, &e);
        return Err(e);
    }

    // Swap then enemy attacks the new active.
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());

    let _events = game_core::resolve_player_swap(
        &mut battle.state,
        game_core::SideId::SideA,
        team_index,
        &skill_defs,
        &type_chart,
        &variance,
    );

    if battle.state.outcome != BattleOutcome::Ongoing {
        write_back_battle_results(ctx, &battle)?;
    }

    ctx.db.battle().battle_id().update(battle);
    Ok(())
}

/// Flee from a battle. Sets outcome to `Fled`; no XP awarded.
#[spacetimedb::reducer]
pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("flee", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("flee", me, &e);
        return Err(e);
    }
    battle.state.outcome = BattleOutcome::Fled;

    // Write back HP via the shared path (no XP on flee — outcome != SideAWins).
    write_back_battle_results(ctx, &battle)?;

    ctx.db.battle().battle_id().update(battle);
    log::info!("{{\"evt\":\"battle_flee\",\"battle_id\":{battle_id},\"sender\":\"{me}\"}}");
    Ok(())
}

/// Heal all party monsters to full HP. Only allowed when the player is NOT in
/// an ongoing battle.
#[spacetimedb::reducer]
pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;

    // Reject if player is in an ongoing battle.
    let in_battle = ctx
        .db
        .battle()
        .player_identity()
        .filter(me)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if in_battle {
        let e = "cannot heal during an ongoing battle".to_string();
        log_reject("heal_party", me, &e);
        return Err(e);
    }

    let monsters: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(me)
        .filter(|m| m.party_slot != PARTY_SLOT_NONE)
        .collect();
    for mut m in monsters {
        m.current_hp = m.stat_hp;
        let pub_row = pub_from_monster(&m);
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(pub_row);
    }

    log::info!("{{\"evt\":\"heal_party\",\"sender\":\"{me}\"}}");
    Ok(())
}

/// Write post-battle HP back to every party monster (HP only — NO XP). Shared by
/// `write_back_battle_results` (the win/loss/flee path) and the M8d recruit
/// success arm (which grants no XP). Dual-writes the private `monster` row and
/// its public projection. Returns `Err` on a `side_a.team` / `party_monster_ids`
/// length mismatch (checked indexing, never panic — M8.5a).
fn write_back_party_hp(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;
    for (i, bm) in battle.state.side_a.team.iter().enumerate() {
        let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
            format!("write_back_party_hp: party_monster_ids index {i} out of range")
        })?;
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            write_back_hp(&mut m, bm);
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }
    Ok(())
}

/// After a battle ends (win/loss), write HP back to all party monsters and
/// grant XP to the winner's team.
fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    // Positional coupling invariant: side_a.team[i] pairs with
    // party_monster_ids[i]. Assert it up front (Err, never panic) so the XP loop
    // below can index by position safely — the §3 criterion requires this
    // assertion in write_back_battle_results specifically (M8.5a). The same
    // assertion also lives in write_back_party_hp, which guards the recruit-success
    // path that calls that helper WITHOUT going through this function.
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;

    // Write back HP for player's team (HP-only; the XP block below is separate).
    write_back_party_hp(ctx, battle)?;

    // GC the private wild-individuality row on ANY terminal outcome (no-op for
    // PvP battles with no `battle_wild` row; cleans wild battles that end via
    // loss/flee/win without a recruit attempt).
    ctx.db.battle_wild().battle_id().delete(battle.battle_id);

    // Grant XP if the player won.
    if battle.state.outcome == BattleOutcome::SideAWins {
        // Find the loser's species base stat total for the XP formula.
        let loser_active = battle.state.side_b.active_monster();
        let loser_species = ctx
            .db
            .species_row()
            .id()
            .find(loser_active.species_id)
            .ok_or_else(|| format!("loser species {} not found", loser_active.species_id))?;
        let bst = loser_base_stat_total(&loser_species);

        // Award XP to each conscious member of the winning team.
        for (i, bm) in battle.state.side_a.team.iter().enumerate() {
            if bm.is_fainted() {
                continue;
            }
            let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
                format!("write_back_battle_results: party_monster_ids index {i} out of range")
            })?;
            if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
                let winner_lvl = game_core::Level::new(bm.level)?;
                let loser_lvl = game_core::Level::new(loser_active.level)?;
                let xp_gained = battle_xp_reward(winner_lvl, bst, loser_lvl);
                let current_xp = game_core::Xp::new(m.xp);
                let (new_xp, new_level, leveled_up) = apply_xp_gain(current_xp, xp_gained);
                m.xp = new_xp.value();
                m.level = new_level.as_u8();
                if leveled_up {
                    // Recompute derived stats on level-up.
                    let sp = ctx.db.species_row().id().find(m.species_id);
                    if let Some(species) = sp {
                        let base = StatBlock {
                            hp: species.base_hp,
                            attack: species.base_attack,
                            defense: species.base_defense,
                            speed: species.base_speed,
                            sp_attack: species.base_sp_attack,
                            sp_defense: species.base_sp_defense,
                        };
                        let ivs = game_core::IVs::new(
                            m.iv_hp,
                            m.iv_attack,
                            m.iv_defense,
                            m.iv_speed,
                            m.iv_sp_attack,
                            m.iv_sp_defense,
                        )?;
                        let evs = game_core::EVs::new(
                            m.ev_hp,
                            m.ev_attack,
                            m.ev_defense,
                            m.ev_speed,
                            m.ev_sp_attack,
                            m.ev_sp_defense,
                        )?;
                        let nature = game_core::Nature::new(m.nature_kind);
                        let lvl = game_core::Level::new(m.level)?;
                        let derived = game_core::derive_stats(&base, &ivs, &evs, &nature, lvl);
                        m.stat_hp = derived.hp;
                        m.stat_attack = derived.attack;
                        m.stat_defense = derived.defense;
                        m.stat_speed = derived.speed;
                        m.stat_sp_attack = derived.sp_attack;
                        m.stat_sp_defense = derived.sp_defense;
                        // Heal the HP gained from the max-HP growth on level-up
                        // (SSOT: game_core owns the heal rule, ADR-0003).
                        m.current_hp = level_up_healed_hp(m.current_hp, bm.max_hp, derived.hp);
                    }
                }
                let pub_row = pub_from_monster(&m);
                ctx.db.monster().monster_id().update(m);
                ctx.db.monster_pub().monster_id().update(pub_row);
            }
        }
    }

    Ok(())
}

// --- Inventory helpers (M8d, ADR-0046 — single stack per (owner, item_id)) -----

/// Grant `qty` of `item_id` to `owner`, merging into the owner's existing stack
/// if present (saturating to avoid overflow) or inserting a new row otherwise.
/// SINGLE stack per `(owner, item_id)`: always find-then-update.
///
/// Currently the ONLY caller is the dev/test reducer `grant_bait`, so this helper
/// shares its `dev_reducers` gate to avoid a dead-code warning in release builds
/// (ADR-0054). The M9 shop will introduce a production caller; drop the gate then.
#[cfg(feature = "dev_reducers")]
fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    let existing = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id);
    match existing {
        Some(mut row) => {
            row.count = row.count.saturating_add(qty);
            ctx.db.inventory().inv_id().update(row);
        }
        None => {
            ctx.db.inventory().insert(Inventory {
                inv_id: 0, // auto_inc
                owner_identity: owner,
                item_id,
                count: qty,
            });
        }
    }
}

/// Consume exactly one of `item_id` from `owner`. Rejects (`Err`) when the stack
/// is absent or already empty. Uses `checked_sub` — NEVER a bare decrement — so
/// an empty stack can never underflow into a 2^32 windfall.
fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
    let mut row = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id)
        .ok_or_else(|| "item not in inventory".to_string())?;
    if row.count == 0 {
        return Err("item count is zero".to_string());
    }
    row.count = row
        .count
        .checked_sub(1)
        .ok_or_else(|| "item count is zero".to_string())?;
    ctx.db.inventory().inv_id().update(row);
    Ok(())
}

/// Attempt to recruit the wild monster in a wild battle (M8d, ADR-0047). The
/// roll is injected (`ctx.random()`), never a client argument. Optional `bait`
/// is classified by data (the item's `recruit_bonus`), consumed BEFORE the roll.
///
/// Success: build the SAME individual from the stored seed (full HP), drop it in
/// the box, write back party HP (NO XP), GC the wild row, end the battle.
/// Failure: advance the turn, let the wild strike back; if that ends the battle,
/// run the full results path (XP/loss handling) + GC.
#[spacetimedb::reducer]
pub fn attempt_recruit(
    ctx: &ReducerContext,
    battle_id: u64,
    bait_item_id: Option<u32>,
) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = match ctx.db.battle().battle_id().find(battle_id) {
        Some(b) => b,
        None => {
            let e = "battle not found".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    let bw = match ctx.db.battle_wild().battle_id().find(battle_id) {
        Some(bw) => bw,
        None => {
            let e = "not a wild battle".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };

    // Bait (optional): classify by data (recruit_bonus), consume BEFORE the roll.
    let mut bait_bonus = 0u16;
    if let Some(id) = bait_item_id {
        let item = match ctx.db.item_row().id().find(id) {
            Some(row) => row,
            None => {
                let e = "unknown item".to_string();
                log_reject("attempt_recruit", me, &e);
                return Err(e);
            }
        };
        let rb = item.recruit_bonus;
        if rb == 0 {
            let e = "item is not bait".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
        consume_one(ctx, me, id)?;
        bait_bonus = rb;
    }

    // Read every value we need off the wild into OWNED locals BEFORE any
    // mutation of `battle.state`, so the fail branch never re-borrows across the
    // `resolve_recruit_failure` turn-counter write (no borrow-across-mutation trap).
    let wild = battle.state.side_b.active_monster();
    let wild_max_hp = wild.max_hp;
    let wild_current_hp = wild.current_hp;

    let chance = recruit_chance(wild_max_hp, wild_current_hp, RECRUIT_BASE_RATE, bait_bonus);
    let roll: u32 = ctx.random();
    let success = game_core::attempt_recruit(chance, roll);

    if success {
        // Rebuild the EXACT wild from the stored seed at its level (full HP).
        let species_row = ctx
            .db
            .species_row()
            .id()
            .find(bw.wild_species_id)
            .ok_or_else(|| format!("wild species {} not found", bw.wild_species_id))?;
        let species_core = game_core::Species {
            id: species_row.id,
            name: species_row.name.clone(),
            base_stats: StatBlock {
                hp: species_row.base_hp,
                attack: species_row.base_attack,
                defense: species_row.base_defense,
                speed: species_row.base_speed,
                sp_attack: species_row.base_sp_attack,
                sp_defense: species_row.base_sp_defense,
            },
            affinity: species_row.affinity,
            learnable_skill_ids: species_row.learnable_skill_ids.clone(),
        };
        let inst = build_monster(
            bw.individuality_seed,
            &species_core,
            Level::new(bw.wild_level)?,
        );
        let row = monster_from_instance(me, &inst, PARTY_SLOT_NONE);
        let inserted = ctx.db.monster().insert(row);
        ctx.db.monster_pub().insert(pub_from_monster(&inserted));

        battle.state.outcome = BattleOutcome::SideAWins;
        // NO XP on recruit (ADR-0047): do NOT swap for write_back_battle_results.
        write_back_party_hp(ctx, &battle)?;
        ctx.db.battle_wild().battle_id().delete(battle_id);
        ctx.db.battle().battle_id().update(battle);
        // Log ONLY public coordinates — NEVER seed/IVs/nature (side-channel).
        log::info!(
            "{{\"evt\":\"recruit_success\",\"battle_id\":{battle_id},\"species_id\":{},\"monster_id\":{}}}",
            bw.wild_species_id,
            inserted.monster_id
        );
        return Ok(());
    }

    // Failure: the recruit roll missed. game_core owns the failed-recruit battle
    // transition (game_core::resolve_recruit_failure): it advances the turn through
    // the SSOT `u16::MAX -> Fled` terminal — NEVER a raw in-shell `turn_number += 1`
    // — and then lets the wild (side B) strike back ONLY if it has a skill and the
    // turn-limit terminal did not fire. The reducer just supplies the skill/type/
    // variance data and persists; the terminal write-back below handles a Fled (or
    // KO) outcome (HP + GC, no XP — Fled is a no-winner terminal).
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());
    let _events = resolve_recruit_failure(&mut battle.state, &skill_defs, &type_chart, &variance);

    if battle.state.outcome != BattleOutcome::Ongoing {
        // Terminal: the wild knocked out the player's last monster, OR the
        // turn-limit terminal (Fled) fired in advance_turn. write_back_battle_results
        // owns terminal GC (it deletes battle_wild unconditionally) and grants XP
        // only on SideAWins, so the Fled terminal writes back HP without XP.
        write_back_battle_results(ctx, &battle)?;
    }
    ctx.db.battle().battle_id().update(battle);
    log::info!("{{\"evt\":\"recruit_fail\",\"battle_id\":{battle_id}}}");
    Ok(())
}

/// DEV/TEST: grant bait to the CALLER only (self-scoped to `ctx.sender`; no
/// arbitrary-recipient parameter). Rejects non-bait items. Superseded by the M9
/// shop. Capped at 99 per call.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(item) = ctx.db.item_row().id().find(item_id) else {
        let e = "item not found".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    };
    if item.recruit_bonus == 0 {
        let e = "not a bait item".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    }
    let capped = qty.min(99);
    grant_item(ctx, ctx.sender, item_id, capped);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::{ActionState, CharacterState, Direction, Millis, TilePos};

    fn row() -> Character {
        Character {
            entity_id: 1,
            zone_id: 0,
            tile_x: 3,
            tile_y: 4,
            facing: Direction::East,
            action: ActionState::Walking,
            move_started_at_ms: 123,
            sprite_id: 0,
            move_queue: Vec::new(),
        }
    }

    #[test]
    fn convert_seam_round_trips() {
        let r = row();
        let s = char_state(&r);
        assert_eq!(s.pos, TilePos { x: 3, y: 4 });
        assert_eq!(s.facing, Direction::East);
        assert_eq!(s.move_started_at, Millis(123));
        let mut r2 = row();
        let next = CharacterState {
            pos: TilePos { x: 9, y: 9 },
            facing: Direction::North,
            action: ActionState::Idle,
            move_started_at: Millis(500),
        };
        apply_state(&mut r2, &next);
        assert_eq!((r2.tile_x, r2.tile_y), (9, 9));
        assert_eq!(r2.facing, Direction::North);
        assert_eq!(r2.move_started_at_ms, 500);
    }

    #[test]
    fn validate_name_rejects_bad() {
        assert!(validate_name("  ").is_err());
        assert!(validate_name(&"x".repeat(25)).is_err());
        assert_eq!(validate_name("  Ash ").as_deref(), Ok("Ash"));
    }

    // === M6b tests ===

    fn test_species() -> game_core::Species {
        game_core::Species {
            id: 1,
            name: "Flameling".to_string(),
            base_stats: StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            },
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1, 2],
        }
    }

    /// monster_from_instance flattens a MonsterInstance into the correct columns.
    #[test]
    fn monster_from_instance_flattens_correctly() {
        let sp = test_species();
        let inst = roll_starter(42, &sp);
        let identity = Identity::from_byte_array([0u8; 32]);
        let m = monster_from_instance(identity, &inst, 0);

        assert_eq!(m.species_id, inst.species_id);
        assert_eq!(m.level, inst.level.as_u8());
        assert_eq!(m.xp, inst.xp.value());
        assert_eq!(m.bond, inst.bond.value());
        assert_eq!(m.iv_hp, inst.ivs.get(StatKind::Hp));
        assert_eq!(m.iv_attack, inst.ivs.get(StatKind::Attack));
        assert_eq!(m.iv_defense, inst.ivs.get(StatKind::Defense));
        assert_eq!(m.iv_speed, inst.ivs.get(StatKind::Speed));
        assert_eq!(m.iv_sp_attack, inst.ivs.get(StatKind::SpAttack));
        assert_eq!(m.iv_sp_defense, inst.ivs.get(StatKind::SpDefense));
        assert_eq!(m.nature_kind, inst.nature.kind());
        assert_eq!(m.ev_hp, inst.evs.get(StatKind::Hp));
        assert_eq!(m.stat_hp, inst.derived_stats.hp);
        assert_eq!(m.stat_attack, inst.derived_stats.attack);
        assert_eq!(m.current_hp, inst.current_hp);
        assert_eq!(m.party_slot, 0);
        assert_eq!(m.owner_identity, identity);
    }

    /// pub_from_monster produces a projection with NO hidden fields.
    #[test]
    fn pub_from_monster_omits_hidden_fields() {
        let sp = test_species();
        let inst = roll_starter(42, &sp);
        let identity = Identity::from_byte_array([1u8; 32]);
        let m = monster_from_instance(identity, &inst, PARTY_SLOT_NONE);
        let p = pub_from_monster(&m);

        // Public fields match
        assert_eq!(p.monster_id, m.monster_id);
        assert_eq!(p.owner_identity, m.owner_identity);
        assert_eq!(p.species_id, m.species_id);
        assert_eq!(p.nickname, m.nickname);
        assert_eq!(p.level, m.level);
        assert_eq!(p.xp, m.xp);
        assert_eq!(p.bond, m.bond);
        assert_eq!(p.current_hp, m.current_hp);
        assert_eq!(p.stat_hp, m.stat_hp);
        assert_eq!(p.stat_attack, m.stat_attack);
        assert_eq!(p.stat_defense, m.stat_defense);
        assert_eq!(p.stat_speed, m.stat_speed);
        assert_eq!(p.stat_sp_attack, m.stat_sp_attack);
        assert_eq!(p.stat_sp_defense, m.stat_sp_defense);
        assert_eq!(p.party_slot, m.party_slot);
        // The MonsterPub struct has no IV/EV/nature fields — this is a compile-time
        // guarantee; the privacy eval enforces it at the source level.
    }

    /// Content parses and validates end-to-end.
    #[test]
    fn content_parses_and_validates() {
        let species = load_species().expect("species parse");
        let skills = load_skills().expect("skills parse");
        let chart = load_type_chart().expect("type_chart parse");
        let items = load_items().expect("items parse");
        validate_content(&species, &skills, &chart, &items).expect("content valid");
        assert!(
            !species.is_empty(),
            "species registry must have entries for starter"
        );
        assert!(!skills.is_empty(), "skills registry must have entries");
    }

    /// The party-slot sentinel does not collide with any valid slot.
    #[test]
    fn party_slot_sentinel_outside_valid_range() {
        for slot in 0..MAX_PARTY_SIZE {
            assert_ne!(
                slot, PARTY_SLOT_NONE,
                "sentinel collides with valid slot {slot}"
            );
        }
    }

    // =========================================================================
    // M7b gating tests — server-module helper seams
    //
    // These tests gate the three pure helper functions that the battle reducers
    // will depend on. They are RED until the implementer adds these helpers to
    // server-module/src/lib.rs.
    //
    // The helpers being gated:
    //   1. battle_monster_from_row(monster, skills) -> BattleMonster
    //      Marshaling seam: Monster table row + species skills -> BattleMonster.
    //
    //   2. write_back_hp(monster_row, battle_monster)
    //      Writes HP from the battle-engine state back to the Monster row.
    //
    //   3. loser_base_stat_total(species_row) -> u16
    //      Sums the six base stats from a SpeciesRow for the XP formula.
    //
    // None of these functions touch ReducerContext — they are pure transformers
    // that can be tested without a SpacetimeDB runtime.
    // =========================================================================

    // -------------------------------------------------------------------------
    // Fixture builders for M7b tests
    // -------------------------------------------------------------------------

    fn m7b_test_monster_row() -> Monster {
        Monster {
            monster_id: 42,
            owner_identity: Identity::from_byte_array([7u8; 32]),
            species_id: 1,
            nickname: "Sparky".to_string(),
            level: 15,
            xp: 0,
            bond: 0,
            iv_hp: 20,
            iv_attack: 25,
            iv_defense: 10,
            iv_speed: 30,
            iv_sp_attack: 15,
            iv_sp_defense: 5,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 0,
            ev_attack: 0,
            ev_defense: 0,
            ev_speed: 0,
            ev_sp_attack: 0,
            ev_sp_defense: 0,
            // Derived stats (set explicitly for test predictability)
            stat_hp: 120,
            stat_attack: 55,
            stat_defense: 45,
            stat_speed: 70,
            stat_sp_attack: 50,
            stat_sp_defense: 40,
            current_hp: 90, // damaged — not at max
            party_slot: 0,
        }
    }

    fn m7b_test_skill_rows() -> Vec<SkillRow> {
        vec![
            SkillRow {
                id: 1,
                name: "Ember".to_string(),
                affinity: Affinity::Fire,
                power: 40,
                accuracy: 100,
                pp: 25,
            },
            SkillRow {
                id: 2,
                name: "Scratch".to_string(),
                affinity: Affinity::Fire,
                power: 40,
                accuracy: 100,
                pp: 35,
            },
        ]
    }

    fn m7b_test_species_row() -> SpeciesRow {
        SpeciesRow {
            id: 1,
            name: "Flameling".to_string(),
            base_hp: 45,
            base_attack: 49,
            base_defense: 49,
            base_speed: 65,
            base_sp_attack: 65,
            base_sp_defense: 45,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1, 2],
        }
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-1: battle_monster_from_row marshaling seam
    //
    // Kills: an impl that swaps species_id and affinity, maps the wrong HP
    // column (using stat_hp instead of current_hp or vice-versa), or copies
    // known_skill_ids from learnable_skill_ids without filtering.
    // -------------------------------------------------------------------------

    /// The function `battle_monster_from_row` must exist in the server module
    /// and produce a BattleMonster whose fields correctly reflect the Monster
    /// table row and the provided skill list.
    ///
    /// Kills: maps stat_hp → current_hp (wrong — battle starts with actual HP),
    /// or maps current_hp → max_hp (wrong — max_hp must equal stat_hp).
    #[test]
    fn m7b_battle_monster_from_row_maps_hp_correctly() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        // current_hp in battle = Monster.current_hp (the persisted damage state)
        assert_eq!(
            bm.current_hp, monster.current_hp,
            "BattleMonster.current_hp must equal Monster.current_hp (90), not stat_hp (120)"
        );
        // max_hp in battle = Monster.stat_hp (the computed maximum)
        assert_eq!(
            bm.max_hp, monster.stat_hp,
            "BattleMonster.max_hp must equal Monster.stat_hp (120), not current_hp (90)"
        );
    }

    /// Kills: an impl that copies all learnable_skill_ids instead of only
    /// the skill_ids present in the provided skills slice, or that maps the
    /// wrong species_id / affinity / level.
    #[test]
    fn m7b_battle_monster_from_row_maps_identity_fields() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        assert_eq!(bm.species_id, monster.species_id, "species_id must match");
        assert_eq!(
            bm.affinity,
            Affinity::Fire,
            "affinity must come from species (Fire)"
        );
        assert_eq!(bm.level, monster.level, "level must match monster.level");
    }

    /// Kills: an impl that uses derived stats from the wrong columns (e.g.
    /// reads iv_attack instead of stat_attack for the StatBlock).
    #[test]
    fn m7b_battle_monster_from_row_maps_derived_stats() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        // The StatBlock in BattleMonster must come from the derived stat columns,
        // not from raw IV/EV values or base stats.
        assert_eq!(bm.stats.hp, monster.stat_hp, "stats.hp must be stat_hp");
        assert_eq!(
            bm.stats.attack, monster.stat_attack,
            "stats.attack must be stat_attack"
        );
        assert_eq!(
            bm.stats.defense, monster.stat_defense,
            "stats.defense must be stat_defense"
        );
        assert_eq!(
            bm.stats.speed, monster.stat_speed,
            "stats.speed must be stat_speed"
        );
        assert_eq!(
            bm.stats.sp_attack, monster.stat_sp_attack,
            "stats.sp_attack must be stat_sp_attack"
        );
        assert_eq!(
            bm.stats.sp_defense, monster.stat_sp_defense,
            "stats.sp_defense must be stat_sp_defense"
        );
    }

    /// Kills: an impl that puts all learnable_skill_ids (from the species) into
    /// known_skill_ids instead of only the IDs present in the provided skills slice.
    /// The skill slice represents what the server has loaded for this monster;
    /// known_skill_ids must reflect exactly those IDs.
    #[test]
    fn m7b_battle_monster_from_row_known_skill_ids_match_skills_slice() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        // Only provide skill 1 (not skill 2) — simulates the monster only knowing one move.
        let one_skill = vec![m7b_test_skill_rows().remove(0)];

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &one_skill).expect("valid row builds");

        assert_eq!(
            bm.known_skill_ids,
            vec![1u32],
            "known_skill_ids must match the provided skills slice (only skill 1)"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-2: write_back_hp writes battle HP to the monster row
    //
    // Kills: an impl that writes max_hp instead of current_hp, writes to the
    // wrong Monster field (e.g. stat_hp), or does not write at all.
    // -------------------------------------------------------------------------

    /// Kills: write_back_hp writes 0 (fainted) back as current_hp.
    #[test]
    fn m7b_write_back_hp_writes_fainted_state() {
        let mut monster = m7b_test_monster_row(); // current_hp = 90
                                                  // Build a BattleMonster representing the fainted state after combat.
        let bm = game_core::BattleMonster {
            species_id: monster.species_id,
            affinity: Affinity::Fire,
            level: monster.level,
            current_hp: 0, // fainted in battle
            max_hp: monster.stat_hp,
            stats: game_core::StatBlock {
                hp: monster.stat_hp,
                attack: monster.stat_attack,
                defense: monster.stat_defense,
                speed: monster.stat_speed,
                sp_attack: monster.stat_sp_attack,
                sp_defense: monster.stat_sp_defense,
            },
            known_skill_ids: vec![1],
        };

        // write_back_hp does not exist yet — this test is RED.
        write_back_hp(&mut monster, &bm);

        assert_eq!(
            monster.current_hp, 0,
            "write_back_hp must set Monster.current_hp = 0 (fainted)"
        );
        // stat_hp must NOT be modified — it is derived, not a battle value.
        assert_eq!(monster.stat_hp, 120, "write_back_hp must not touch stat_hp");
    }

    /// Kills: write_back_hp that caps HP at max_hp (ignoring current_hp).
    #[test]
    fn m7b_write_back_hp_writes_partial_damage() {
        let mut monster = m7b_test_monster_row(); // current_hp = 90 initially
        let partial_hp: u16 = 37;
        let bm = game_core::BattleMonster {
            species_id: monster.species_id,
            affinity: Affinity::Fire,
            level: monster.level,
            current_hp: partial_hp,
            max_hp: monster.stat_hp,
            stats: game_core::StatBlock {
                hp: monster.stat_hp,
                attack: monster.stat_attack,
                defense: monster.stat_defense,
                speed: monster.stat_speed,
                sp_attack: monster.stat_sp_attack,
                sp_defense: monster.stat_sp_defense,
            },
            known_skill_ids: vec![1],
        };

        write_back_hp(&mut monster, &bm);

        assert_eq!(
            monster.current_hp, partial_hp,
            "write_back_hp must write current_hp = {partial_hp}, not cap or round"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-3: loser_base_stat_total sums the six base stats correctly
    //
    // Kills: an impl that sums derived stats (stat_hp etc.) instead of base
    // stats, sums only five stats (off-by-one), or wraps on overflow.
    // -------------------------------------------------------------------------

    /// Kills: an impl that returns the sum of derived stats (monster row's
    /// stat_hp etc.) instead of the six BASE stat columns from the species row.
    /// 45 + 49 + 49 + 65 + 65 + 45 = 318 (Flameling base stat total).
    #[test]
    fn m7b_loser_base_stat_total_flameling() {
        let species = m7b_test_species_row();

        // The explicit `u16` binding pins the signature: a return-type
        // regression (or dropping the game_core::base_stat_total delegation
        // for a wider type) fails to compile here.
        let bst: u16 = loser_base_stat_total(&species);

        assert_eq!(
            bst, 318,
            "loser_base_stat_total must sum the six BASE stats: \
             45+49+49+65+65+45 = 318, got {bst}"
        );
    }

    /// Kills: an impl that only sums five stats (off-by-one on the stat fields).
    #[test]
    fn m7b_loser_base_stat_total_high_bst_species() {
        // A species with high base stats — verifies all six fields are summed.
        let species = SpeciesRow {
            id: 99,
            name: "Apexion".to_string(),
            base_hp: 100,
            base_attack: 120,
            base_defense: 90,
            base_speed: 100,
            base_sp_attack: 130,
            base_sp_defense: 90,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![],
        };
        // 100 + 120 + 90 + 100 + 130 + 90 = 630
        let bst: u16 = loser_base_stat_total(&species);
        assert_eq!(
            bst, 630,
            "loser_base_stat_total must sum all six base stats: \
             100+120+90+100+130+90 = 630, got {bst}"
        );
    }

    /// Kills: an impl that wraps on u16 overflow. All six base stats at 255 = 1530,
    /// which fits in u16 (max 65535). But if the impl uses u8 intermediates, 255*6=1530
    /// wraps to 250. This test catches that.
    #[test]
    fn m7b_loser_base_stat_total_max_stats_no_overflow() {
        let species = SpeciesRow {
            id: 0,
            name: "MaxStat".to_string(),
            base_hp: 255,
            base_attack: 255,
            base_defense: 255,
            base_speed: 255,
            base_sp_attack: 255,
            base_sp_defense: 255,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![],
        };
        // 255 * 6 = 1530, which fits in u16.
        let bst: u16 = loser_base_stat_total(&species);
        assert_eq!(
            bst, 1530,
            "loser_base_stat_total must not overflow u8; 255*6=1530, got {bst}"
        );
    }

    // =========================================================================
    // M8.5b gating tests — battle_monster_from_row trust boundary (defense==0)
    //
    // These tests gate the signature change for `battle_monster_from_row`:
    // it must become `-> Result<BattleMonster, String>` and reject rows
    // where `monster.stat_defense == 0`.
    //
    // All tests in this block are compile-RED until the signature changes.
    // =========================================================================

    // -------------------------------------------------------------------------
    // TEST M8.5b-A-3: battle_monster_from_row rejects zero defense
    //
    // Kills: an impl that passes defense==0 through to BattleMonster (which
    // would later cause a divide-by-zero in calc_damage).
    // -------------------------------------------------------------------------

    /// Kills: an impl that silently returns Ok(..) for a zero-defense row instead
    /// of Err. If battle_monster_from_row doesn't validate stat_defense, a
    /// defense==0 BattleMonster reaches calc_damage and causes UB/panic there.
    ///
    /// PROOF-OF-TEETH: the positive sibling below ensures the implementer can't
    /// trivially make this pass by returning Err for ALL inputs.
    ///
    /// RED state: compile-RED because `battle_monster_from_row` currently returns
    /// `BattleMonster` (not `Result`), so `.is_err()` does not compile.
    #[test]
    fn battle_monster_from_row_rejects_zero_defense() {
        let mut monster = m7b_test_monster_row();
        monster.stat_defense = 0; // precondition violation: defense must be >= 1

        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let result: Result<game_core::BattleMonster, String> =
            battle_monster_from_row(&monster, &species, &skills);

        assert!(
            result.is_err(),
            "TEETH: battle_monster_from_row must reject stat_defense==0 with Err; \
             an impl that passes it through would return Ok(..) and this assertion fails"
        );
    }

    /// Sibling positive test: a normal row (defense > 0) must succeed.
    ///
    /// Kills: a vacuous always-Err impl. Without this test, an implementer could
    /// make the reject test pass by unconditionally returning Err("nope"), which
    /// would break all callers. This test ensures the happy path still works.
    ///
    /// RED state: compile-RED (same signature change required).
    #[test]
    fn battle_monster_from_row_accepts_nonzero_defense() {
        let monster = m7b_test_monster_row(); // stat_defense = 45 (non-zero)
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let result: Result<game_core::BattleMonster, String> =
            battle_monster_from_row(&monster, &species, &skills);

        assert!(
            result.is_ok(),
            "battle_monster_from_row must return Ok(..) for a valid row with \
             stat_defense={} (> 0); got Err",
            monster.stat_defense
        );
        // Spot-check that the result still maps correctly (regression guard)
        let bm = result.unwrap();
        assert_eq!(bm.stats.defense, monster.stat_defense);
    }

    // =========================================================================
    // M8b gating tests — encounter_rows_from_table marshaling seam
    //
    // These tests gate the pure function `encounter_rows_from_table` that the
    // implementer will add to server-module/src/lib.rs. The function does NOT
    // exist yet — this entire block is RED (crate won't compile until added).
    //
    // Mirror: monster_from_instance_flattens_correctly (lib.rs ~1359).
    // Flatten-at-boundary: Level -> u8 (same pattern as Millis -> i64).
    //
    // Symbols referenced (not yet defined — intentionally RED):
    //   encounter_rows_from_table(&game_core::EncounterTable) -> EncounterRow
    //   struct EncounterRow { zone_id: u32, encounter_rate: u16, entries: Vec<EncounterEntryRow> }
    //   struct EncounterEntryRow { species_id: u32, weight: u16, min_level: u8, max_level: u8 }
    // =========================================================================

    // -------------------------------------------------------------------------
    // Fixture builder for M8b marshaling tests
    // -------------------------------------------------------------------------

    fn m8b_test_encounter_table() -> game_core::EncounterTable {
        game_core::EncounterTable {
            zone_id: 42,
            encounter_rate: 350,
            entries: vec![
                game_core::EncounterEntry {
                    species_id: 1,
                    weight: 60,
                    min_level: game_core::Level::new(3).expect("valid level"),
                    max_level: game_core::Level::new(7).expect("valid level"),
                },
                game_core::EncounterEntry {
                    species_id: 2,
                    weight: 30,
                    min_level: game_core::Level::new(5).expect("valid level"),
                    max_level: game_core::Level::new(10).expect("valid level"),
                },
                game_core::EncounterEntry {
                    species_id: 3,
                    weight: 10,
                    min_level: game_core::Level::new(8).expect("valid level"),
                    max_level: game_core::Level::new(15).expect("valid level"),
                },
            ],
        }
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-1: encounter_rows_from_table flattens correctly
    //
    // Kills: min/max swap; Level-not-flattened (storing a newtypes struct instead
    // of u8); wrong zone_id or encounter_rate copied; entry count wrong.
    // -------------------------------------------------------------------------

    /// encounter_rows_from_table must flatten a game_core::EncounterTable into
    /// an EncounterRow with the correct zone_id, encounter_rate, entry count,
    /// and correct per-entry species_id/weight/min_level/max_level (as u8).
    ///
    /// Kills: an impl that swaps min_level/max_level columns,
    ///        stores Level newtype instead of u8,
    ///        or copies the wrong zone_id.
    #[test]
    fn encounter_rows_from_table_flattens_correctly() {
        let table = m8b_test_encounter_table();

        // encounter_rows_from_table does not exist yet — this test is RED.
        let row: EncounterRow = encounter_rows_from_table(&table);

        // Top-level fields
        assert_eq!(row.zone_id, 42, "zone_id must be copied from table.zone_id");
        assert_eq!(
            row.encounter_rate, 350,
            "encounter_rate must be copied from table.encounter_rate"
        );
        assert_eq!(
            row.entries.len(),
            3,
            "entries.len() must equal source table entries count (3)"
        );

        // Entry 0: species=1, weight=60, min=3, max=7
        assert_eq!(
            row.entries[0].species_id, 1,
            "entries[0].species_id must be 1"
        );
        assert_eq!(row.entries[0].weight, 60, "entries[0].weight must be 60");
        assert_eq!(
            row.entries[0].min_level, 3,
            "entries[0].min_level must be 3 (Level flattened to u8)"
        );
        assert_eq!(
            row.entries[0].max_level, 7,
            "entries[0].max_level must be 7 (Level flattened to u8)"
        );

        // Entry 1: species=2, weight=30, min=5, max=10
        assert_eq!(
            row.entries[1].species_id, 2,
            "entries[1].species_id must be 2"
        );
        assert_eq!(row.entries[1].weight, 30, "entries[1].weight must be 30");
        assert_eq!(
            row.entries[1].min_level, 5,
            "entries[1].min_level must be 5"
        );
        assert_eq!(
            row.entries[1].max_level, 10,
            "entries[1].max_level must be 10"
        );

        // Entry 2: species=3, weight=10, min=8, max=15
        assert_eq!(
            row.entries[2].species_id, 3,
            "entries[2].species_id must be 3"
        );
        assert_eq!(row.entries[2].weight, 10, "entries[2].weight must be 10");
        assert_eq!(
            row.entries[2].min_level, 8,
            "entries[2].min_level must be 8"
        );
        assert_eq!(
            row.entries[2].max_level, 15,
            "entries[2].max_level must be 15"
        );
    }

    /// ORDER PRESERVATION: entry[i] in the source maps to entries[i] in the row.
    /// Kills: an impl that reverses or re-sorts entries.
    #[test]
    fn encounter_rows_from_table_preserves_entry_order() {
        let table = m8b_test_encounter_table();
        let row: EncounterRow = encounter_rows_from_table(&table);

        // The species_ids in insertion order are [1, 2, 3] — verify the row
        // preserves this order exactly.
        let species_order: Vec<u32> = row.entries.iter().map(|e| e.species_id).collect();
        assert_eq!(
            species_order,
            vec![1u32, 2, 3],
            "entry order must be preserved: [1,2,3] → kills any sorting/reversing impl"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-2: distinct min/max levels are preserved (not swapped, not const)
    //
    // Kills: an impl that writes min into max (or vice-versa), or uses a single
    // constant level for all entries.
    // -------------------------------------------------------------------------

    /// Each entry in the fixture has DISTINCT min and max levels (min != max,
    /// and all three entries have different min/max pairs). This test verifies
    /// that both fields are individually correct, killing a mutant that copies
    /// min into max or uses a constant.
    ///
    /// Kills: min-into-max copy; max-into-min copy; const(1) for all levels.
    #[test]
    fn encounter_rows_from_table_preserves_distinct_levels() {
        let table = m8b_test_encounter_table();
        let row: EncounterRow = encounter_rows_from_table(&table);

        // All three entries have distinct min ≠ max — ensures neither field is
        // aliased to the other.
        for (i, entry) in row.entries.iter().enumerate() {
            assert_ne!(
                entry.min_level, entry.max_level,
                "entries[{i}]: min_level ({}) must differ from max_level ({}) — \
                 kills any impl that copies one field into the other",
                entry.min_level, entry.max_level
            );
        }

        // Verify the actual u8 values of all six level fields are distinct enough
        // to catch a constant-level impl (e.g., always writing 1).
        // min levels: 3, 5, 8 — all different
        let min_levels: Vec<u8> = row.entries.iter().map(|e| e.min_level).collect();
        assert_eq!(
            min_levels,
            vec![3u8, 5, 8],
            "min_levels across entries must be [3,5,8] — kills const-level impl"
        );

        // max levels: 7, 10, 15 — all different
        let max_levels: Vec<u8> = row.entries.iter().map(|e| e.max_level).collect();
        assert_eq!(
            max_levels,
            vec![7u8, 10, 15],
            "max_levels across entries must be [7,10,15] — kills const-level impl"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-3: empty entries → empty row entries, no panic
    //
    // B1 validation prevents empty tables from reaching sync_content_inner, but
    // encounter_rows_from_table must be total (no panic on empty input).
    // -------------------------------------------------------------------------

    /// encounter_rows_from_table with empty entries must produce a row with
    /// entries.is_empty() == true and must not panic.
    ///
    /// Kills: any impl that indexes entries[0] unconditionally.
    #[test]
    fn encounter_rows_from_table_empty_entries() {
        let table = game_core::EncounterTable {
            zone_id: 99,
            encounter_rate: 100,
            entries: vec![],
        };

        // Must not panic — B1 blocks empties before seeding, but the helper
        // must be total regardless.
        let row: EncounterRow = encounter_rows_from_table(&table);

        assert_eq!(row.zone_id, 99, "zone_id preserved for empty-entries table");
        assert_eq!(
            row.encounter_rate, 100,
            "encounter_rate preserved for empty-entries table"
        );
        assert!(
            row.entries.is_empty(),
            "empty source entries → empty row entries (no panic)"
        );
    }

    // =========================================================================
    // --- M8c gating tests ---
    //
    // Gate the PURE wild-monster build helper the implementer will add:
    //   fn wild_battle_monster(species: &SpeciesRow, skill_ids: &[u32],
    //                          level: u8, seed: u32) -> Result<BattleMonster, String>
    // (full-HP, EVs-zero, IVs/nature from game_core::roll_individuality(seed),
    //  derived via game_core::derive_stats, Level::new(level)?).
    //
    // The helper does NOT exist yet → this block is RED (won't compile until it
    // is added). Mirrors the M7b `battle_monster_from_row` tests above.
    //
    // ASSUMPTION (documented per the handoff): the pure signature is
    //   wild_battle_monster(&SpeciesRow, &[u32], u8, u32) -> Result<BattleMonster, String>
    // where `skill_ids` is the set of skill ids the server has loaded; the helper
    // intersects them with the species' learnable_skill_ids for known_skill_ids
    // (same contract as battle_monster_from_row's skill handling). If the
    // implementer picks a slightly different PURE signature it must keep: no ctx,
    // deterministic in seed, full-HP, EVs-zero, Err (not panic) on bad level.
    // =========================================================================

    fn m8c_test_species_row() -> SpeciesRow {
        SpeciesRow {
            id: 7,
            name: "Wildling".to_string(),
            base_hp: 50,
            base_attack: 55,
            base_defense: 45,
            base_speed: 60,
            base_sp_attack: 65,
            base_sp_defense: 50,
            affinity: Affinity::Plant,
            learnable_skill_ids: vec![1, 2, 3],
        }
    }

    /// EARS (R-D / M8d rebuild contract): the wild build is DETERMINISTIC in the
    /// seed — same seed ⇒ byte-identical BattleMonster.
    /// Kills: an impl that draws from a non-seed RNG or ignores the seed when
    /// rolling individuality (so the stored seed could not rebuild the same wild).
    #[test]
    fn wild_battle_monster_is_deterministic_in_seed() {
        let sp = m8c_test_species_row();
        let skill_ids = [1u32, 2, 3];
        let a = wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234)
            .expect("valid level builds a wild");
        let b = wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234)
            .expect("valid level builds a wild");
        assert_eq!(a, b, "same seed must build an identical BattleMonster");
    }

    /// EARS: a freshly-spawned wild is at FULL HP — current_hp == max_hp == derived
    /// HP, and the level/species come through.
    /// Kills: an impl that starts the wild damaged (current_hp != max_hp), or that
    /// sets max_hp from the wrong stat.
    #[test]
    fn wild_battle_monster_is_full_hp_and_carries_level_species() {
        let sp = m8c_test_species_row();
        let bm = wild_battle_monster(&sp, &[1, 2, 3], 18, 42).expect("valid level builds a wild");
        assert_eq!(
            bm.current_hp, bm.max_hp,
            "a fresh wild must be at full HP (current_hp == max_hp)"
        );
        assert_eq!(
            bm.max_hp, bm.stats.hp,
            "max_hp must equal the derived HP stat"
        );
        assert_eq!(bm.level, 18, "level must be the requested wild level");
        assert_eq!(
            bm.species_id, sp.id,
            "species_id must come from the species"
        );
        assert_eq!(
            bm.affinity, sp.affinity,
            "affinity must come from the species"
        );
    }

    /// EARS: known_skill_ids = the species' learnable filtered by the provided
    /// skill ids (same contract as the owned-monster build).
    /// Kills: an impl that copies ALL provided skill ids (ignoring learnable), or
    /// copies ALL learnable (ignoring the provided set).
    #[test]
    fn wild_battle_monster_known_skills_are_learnable_intersect_provided() {
        let sp = m8c_test_species_row(); // learnable = [1,2,3]
                                         // Provide skill ids 2, 3, and 9 — but 9 is NOT learnable by this species.
        let bm = wild_battle_monster(&sp, &[2, 3, 9], 10, 5).expect("valid level builds a wild");
        assert_eq!(
            bm.known_skill_ids,
            vec![2u32, 3],
            "known_skill_ids must be learnable ∩ provided ([1,2,3] ∩ [2,3,9] = [2,3]); \
             kills copy-all-provided (would include 9) and copy-all-learnable (would include 1)"
        );
    }

    /// EARS (R-D): an out-of-range level is a loud `Err`, NEVER a panic (the wild
    /// build must be total over arbitrary content levels).
    /// Kills: an impl that calls `Level::new(level).unwrap()` (panics on 0 / 250)
    /// instead of propagating the error.
    #[test]
    fn wild_battle_monster_bad_level_is_err_not_panic() {
        let sp = m8c_test_species_row();
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 0, 1).is_err(),
            "level 0 must be an Err (Level::new rejects 0), not a panic"
        );
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 250, 1).is_err(),
            "level 250 must be an Err (Level::new rejects > 100), not a panic"
        );
        // A boundary valid level must still succeed.
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 100, 1).is_ok(),
            "level 100 is valid and must build a wild"
        );
    }

    /// EARS (M8d rebuild contract — the load-bearing one): the wild's derived stats
    /// are EXACTLY what `game_core::roll_individuality(seed)` → `derive_stats(...)`
    /// produces with EVs zero. This is what makes the stored `individuality_seed`
    /// truly rebuild the same wild in M8d.
    /// Kills: an impl that rolls individuality from a different seed transform,
    /// uses non-zero EVs, or derives stats with the wrong inputs — any of which
    /// would make the persisted seed rebuild a DIFFERENT monster than the one fought.
    #[test]
    fn wild_battle_monster_stats_match_roll_individuality_then_derive_stats() {
        let sp = m8c_test_species_row();
        let seed = 0x0BAD_F00D;
        let wild_level = 14u8;
        let bm = wild_battle_monster(&sp, &[1, 2, 3], wild_level, seed)
            .expect("valid level builds a wild");

        // Reconstruct the EXACT expected derived stats from the SSOT pure path.
        let (ivs, nature) = game_core::roll_individuality(seed);
        let base = StatBlock {
            hp: sp.base_hp,
            attack: sp.base_attack,
            defense: sp.base_defense,
            speed: sp.base_speed,
            sp_attack: sp.base_sp_attack,
            sp_defense: sp.base_sp_defense,
        };
        let level = game_core::Level::new(wild_level).expect("valid level");
        let expected =
            game_core::derive_stats(&base, &ivs, &game_core::EVs::zero(), &nature, level);

        assert_eq!(
            bm.stats, expected,
            "wild stats must equal roll_individuality(seed) → derive_stats(.., EVs::zero, ..); \
             this is the M8d 'rebuild THAT exact wild' contract"
        );
        // And max_hp must equal the derived HP stat (full-HP coupling).
        assert_eq!(
            bm.max_hp, expected.hp,
            "max_hp must equal the derived HP stat from the same roll"
        );
    }

    // =========================================================================
    // M8.5a tests — Battle security & integrity (§3 criteria)
    //
    // Tests three pure helper functions called from start_battle / write_back_*:
    //
    //   fn check_party_size(n: usize) -> Result<(), String>
    //     Ok for 1..=MAX_PARTY_SIZE, Err when n == 0 or n > MAX_PARTY_SIZE.
    //     (§3 criterion 2: start_battle rejects if party_monster_ids.len() > MAX_PARTY_SIZE)
    //
    //   fn check_team_coupling(team_len: usize, ids_len: usize) -> Result<(), String>
    //     Ok iff team_len == ids_len, else Err.
    //     (§3 criterion 3: write_back_battle_results asserts side_a.team.len() ==
    //      party_monster_ids.len() and uses checked get(i), returning Err not panic)
    //
    //   fn check_monster_in_party(slot: u8) -> Result<(), String>
    //     Err iff slot == PARTY_SLOT_NONE, Ok otherwise.
    //     (§3 criterion 2: start_battle rejects any boxed monster)
    //
    // None of these functions touch ReducerContext — they are pure validators
    // that can be tested without a SpacetimeDB runtime.
    // =========================================================================

    // -------------------------------------------------------------------------
    // TEST M8.5a-1: check_party_size — §3 criterion 2
    //
    // start_battle must reject (Err) if party_monster_ids.len() > MAX_PARTY_SIZE.
    // The helper is the extracted pure validator for that gate.
    //
    // Kills: an impl that clamps instead of rejecting (returns Ok for n=7 with
    //        MAX_PARTY_SIZE=6, silently truncating the party); an impl that uses
    //        u8 overflow (n=256 wraps to 0 and incorrectly passes); an impl that
    //        rejects n=MAX_PARTY_SIZE (off-by-one — the max is inclusive).
    // -------------------------------------------------------------------------

    /// §3-criterion-2: check_party_size(0) must be Err — an empty party is
    /// invalid; start_battle with zero monsters must be rejected.
    /// Kills: an impl that uses `n > MAX_PARTY_SIZE` only (misses the lower
    /// bound; `1..=MAX_PARTY_SIZE` is the valid range).
    #[test]
    fn party_size_cap_rejects_empty() {
        assert!(
            check_party_size(0).is_err(),
            "check_party_size(0) must be Err (empty party is not valid; range is 1..=MAX_PARTY_SIZE)"
        );
    }

    /// §3-criterion-2: check_party_size(1) must be Ok — minimum valid party.
    /// Kills: an impl that rejects any n < 2 (fencepost).
    #[test]
    fn party_size_cap_accepts_minimum() {
        assert!(
            check_party_size(1).is_ok(),
            "check_party_size(1) must be Ok (minimum valid party of 1)"
        );
    }

    /// §3-criterion-2: check_party_size(MAX_PARTY_SIZE) must be Ok — the
    /// maximum is inclusive.
    /// Kills: an impl that uses `>= MAX_PARTY_SIZE` instead of `> MAX_PARTY_SIZE`
    /// (off-by-one that rejects a full but legal party of 6).
    #[test]
    fn party_size_cap_accepts_max() {
        assert!(
            check_party_size(MAX_PARTY_SIZE as usize).is_ok(),
            "check_party_size(MAX_PARTY_SIZE) must be Ok (max is inclusive, not exclusive)"
        );
    }

    /// §3-criterion-2: check_party_size(MAX_PARTY_SIZE + 1) must be Err —
    /// one over the cap is rejected.
    /// Kills: a clamp-not-reject impl that silently truncates to 6 and returns Ok.
    #[test]
    fn party_size_cap_rejects_oversized() {
        assert!(
            check_party_size(MAX_PARTY_SIZE as usize + 1).is_err(),
            "check_party_size(MAX_PARTY_SIZE + 1) must be Err (oversized party must be rejected, not clamped)"
        );
    }

    /// §3-criterion-2: check_party_size(100) must be Err — far over the cap.
    /// Kills: an impl that only rejects n exactly equal to MAX_PARTY_SIZE+1
    /// rather than all n > MAX_PARTY_SIZE.
    #[test]
    fn party_size_cap_rejects_large() {
        assert!(
            check_party_size(100).is_err(),
            "check_party_size(100) must be Err (any n > MAX_PARTY_SIZE is rejected)"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8.5a-2: check_team_coupling — §3 criterion 3
    //
    // write_back_battle_results asserts side_a.team.len() == party_monster_ids.len()
    // and uses checked get(i), returning Err not panicking on mismatch.
    // The helper is the extracted pure validator for that assertion.
    //
    // Kills: an impl that uses unchecked indexing (panics on mismatch instead
    //        of returning Err); an impl that always returns Ok regardless of
    //        lengths; an impl that accepts team_len > ids_len silently.
    // -------------------------------------------------------------------------

    /// §3-criterion-3: equal lengths must be Ok — the normal post-battle path.
    /// Kills: an impl that always returns Err.
    #[test]
    fn team_coupling_accepts_equal_lengths() {
        assert!(
            check_team_coupling(3, 3).is_ok(),
            "check_team_coupling(3, 3) must be Ok (lengths match)"
        );
    }

    /// §3-criterion-3: (1, 1) must be Ok — minimal valid single-monster battle.
    /// Kills: a "both >= 3" mutation that only accepts larger counts, and an
    /// impl that has an off-by-one requiring lengths > 1.
    #[test]
    fn team_coupling_accepts_minimal_valid() {
        assert!(
            check_team_coupling(1, 1).is_ok(),
            "check_team_coupling(1, 1) must be Ok (single monster on each side)"
        );
    }

    /// §3-criterion-3: (6, 6) must be Ok — full party, all coupled.
    /// Kills: an impl that only accepts small counts.
    #[test]
    fn team_coupling_accepts_max_party_equal() {
        assert!(
            check_team_coupling(6, 6).is_ok(),
            "check_team_coupling(6, 6) must be Ok (full party with matching ids)"
        );
    }

    /// §3-criterion-3: team_len > ids_len must be Err — the team has MORE
    /// monsters than recorded ids, so indexed access would panic.
    /// Kills: an impl that only checks the other direction, or uses unchecked
    ///        indexing (team[i] where i >= ids.len() would panic).
    #[test]
    fn team_coupling_rejects_length_mismatch_team_longer() {
        assert!(
            check_team_coupling(3, 2).is_err(),
            "check_team_coupling(3, 2) must be Err (team has 3 members but only 2 ids — panic path)"
        );
    }

    /// §3-criterion-3: team_len < ids_len must be Err — the ids list has MORE
    /// entries than actual team members, indicating a consistency bug.
    /// Kills: an impl that silently ignores trailing ids (wrong; an invariant
    ///        violation must surface as an Err, not a silent truncation).
    #[test]
    fn team_coupling_rejects_length_mismatch_ids_longer() {
        assert!(
            check_team_coupling(0, 1).is_err(),
            "check_team_coupling(0, 1) must be Err (0 team members but 1 id — invariant violation)"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8.5a-3: check_monster_in_party — §3 criterion 2 (boxed-monster)
    //
    // §3 criterion 2 requires start_battle to reject any listed monster that
    // is boxed (party_slot == PARTY_SLOT_NONE). The helper is the extracted
    // pure slot validator for that gate.
    //
    // Signature: fn check_monster_in_party(slot: u8) -> Result<(), String>
    //   Returns Err iff slot == PARTY_SLOT_NONE, Ok otherwise.
    //
    // This is a SEPARATE concern from check_party_size (size cap): even a
    // party of 1 is invalid if that 1 monster is boxed.
    //
    // Kills: an impl that accepts any slot value (always Ok); an impl that
    //        treats PARTY_SLOT_NONE as a normal slot index (off-by-one on
    //        the sentinel); an impl that rejects ALL non-zero slots
    //        (would block valid party positions 1..MAX_PARTY_SIZE-1).
    // -------------------------------------------------------------------------

    /// §3-criterion-2 (boxed): slot 0 is a valid party position; must be Ok.
    /// Kills: an impl that rejects slot 0 (confuses the first slot with empty).
    #[test]
    fn check_monster_in_party_accepts_first_slot() {
        assert!(
            check_monster_in_party(0).is_ok(),
            "check_monster_in_party(0) must be Ok (slot 0 is a valid party position)"
        );
    }

    /// §3-criterion-2 (boxed): the last valid party slot (MAX_PARTY_SIZE - 1)
    /// must be Ok.
    /// Kills: an impl that rejects any slot >= MAX_PARTY_SIZE - 1.
    #[test]
    fn check_monster_in_party_accepts_last_valid_slot() {
        assert!(
            check_monster_in_party(MAX_PARTY_SIZE - 1).is_ok(),
            "check_monster_in_party(MAX_PARTY_SIZE - 1) must be Ok (last valid party slot)"
        );
    }

    /// §3-criterion-2 (boxed): PARTY_SLOT_NONE (255) signals a boxed monster
    /// and must be Err — start_battle must reject boxed monsters.
    /// Kills: an impl that accepts all u8 values including the sentinel; an
    ///        impl that only rejects values > MAX_PARTY_SIZE (missing the exact
    ///        sentinel check); an impl that returns Ok(()) unconditionally.
    #[test]
    fn check_monster_in_party_rejects_party_slot_none() {
        assert!(
            check_monster_in_party(PARTY_SLOT_NONE).is_err(),
            "check_monster_in_party(PARTY_SLOT_NONE) must be Err (255 = boxed; must be rejected)"
        );
    }

    // =========================================================================
    // M8.8b-C: SSOT-wiring source-guard tests
    //
    // These parse the source text of this file (server-module/src/lib.rs) to
    // verify that `attempt_recruit` routes turn-advance through `advance_turn`
    // (ADR-0003 SSOT) rather than re-implementing it inline, and that the
    // level-up HP heal is delegated to `game_core::level_up_healed_hp` rather
    // than re-inlined here.
    //
    // These tests compile on day 1 (they only do string processing) and fail
    // at RUNTIME — runtime-RED — because today's source has:
    //   `battle.state.turn_number += 1;`  (raw inline increment)
    //   `m.current_hp.saturating_add(derived.hp.saturating_sub(bm.max_hp))`
    //     (inlined heal formula)
    // and does NOT contain `advance_turn` or `level_up_healed_hp`.
    //
    // Mirror: evals/recruit-reducer-security.eval.mjs (extractReducerBody logic).
    // =========================================================================

    /// Include the full source of this file at compile time so the guard runs
    /// without any filesystem I/O at test time.
    const LIB_RS_SOURCE: &str = include_str!("lib.rs");

    /// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
    /// `src`. Returns a new String with those regions replaced by spaces (same
    /// byte-length, so line numbers are preserved for debugging).
    ///
    /// This is a simple linear scanner — no regex crates required.
    /// Corner-cases handled:
    ///   - Nested block comments are NOT supported (Rust does support them, but
    ///     no production code in this file uses them, and the eval does not either).
    ///   - String literals containing `/*` or `//` are NOT special-cased — this
    ///     is intentional: we only need to remove comments so the body-search
    ///     does not accidentally match a commented-out `turn_number +=`.
    fn strip_rust_comments(src: &str) -> String {
        let bytes = src.as_bytes();
        let len = bytes.len();
        let mut out = vec![b' '; len];
        let mut i = 0;
        while i < len {
            if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                // Block comment: blank everything until the matching `*/`.
                i += 2;
                while i + 1 < len {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
                // Line comment: blank everything to the end of the line.
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            } else {
                out[i] = bytes[i];
                i += 1;
            }
        }
        // SAFETY: we only copy ASCII bytes from the original UTF-8 source and
        // replace with spaces (0x20), which are valid UTF-8. The original source
        // is valid UTF-8 (Rust source files must be). So `out` is valid UTF-8.
        String::from_utf8(out).expect("stripped source must be valid UTF-8")
    }

    /// Extract the body of a named `fn` from `src` (comment-stripped).
    ///
    /// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then
    /// counts braces to find the matching `}`. Returns the slice BETWEEN the
    /// outer braces (exclusive), or `None` if the function is not found.
    ///
    /// Mirrors `extractReducerBody` in evals/recruit-reducer-security.eval.mjs.
    fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
        // Try `pub fn <name>(` first, then `fn <name>(`.
        let pub_needle = format!("pub fn {}(", name);
        let priv_needle = format!("fn {}(", name);
        let fn_start = src
            .find(pub_needle.as_str())
            .or_else(|| src.find(priv_needle.as_str()))?;

        // Walk forward from fn_start to find the opening `{`.
        let after_fn = &src[fn_start..];
        let brace_offset = after_fn.find('{')?;
        let body_start = fn_start + brace_offset + 1; // character after '{'

        // Count brace depth to find the matching '}'.
        // `rel` tracks the byte offset within `src[body_start..]`.
        let mut depth: usize = 1;
        let mut rel: usize = 0;
        let chars: Vec<char> = src[body_start..].chars().collect();
        let mut char_pos = 0;
        while char_pos < chars.len() && depth > 0 {
            match chars[char_pos] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            rel += chars[char_pos].len_utf8();
            char_pos += 1;
        }

        if depth == 0 {
            Some(&src[body_start..body_start + rel])
        } else {
            None // unbalanced braces (should not happen in valid Rust)
        }
    }

    /// SSOT wiring: `attempt_recruit` must delegate the entire failed-recruit
    /// battle transition (turn advance + optional strike-back) to the pure
    /// game-core fn `resolve_recruit_failure` (ADR-0003). The u16::MAX→Fled
    /// terminal, the skill-less-wild guard, and the correct operand order are
    /// all owned by that fn and proven by its game-core behavioral tests.
    /// Merely calling `advance_turn` directly in the reducer (with the return
    /// value ignored, inverted, or anded with wild_has_skills) would pass a
    /// purely textual `advance_turn` guard but be behaviorally wrong — hence
    /// this guard checks for `resolve_recruit_failure` instead.
    ///
    /// RED today: the reducer body contains `battle.state.turn_number += 1;`
    /// and does NOT mention `resolve_recruit_failure`.
    ///
    /// After the implementer's change: body calls `resolve_recruit_failure`
    /// and no longer contains a raw `turn_number +=`.
    #[test]
    fn attempt_recruit_routes_turn_advance_through_game_core() {
        let stripped = strip_rust_comments(LIB_RS_SOURCE);
        let body = extract_fn_body(&stripped, "attempt_recruit")
            .expect("attempt_recruit function must exist in lib.rs");

        // Positive: the body must call the pure game-core transition fn.
        // This string does NOT appear in this test's own text (the test module
        // body is outside the extracted attempt_recruit slice), so the check
        // has genuine teeth.
        assert!(
            body.contains("resolve_recruit_failure"),
            "TEETH(ADR-0003 SSOT): attempt_recruit body must call \
             `resolve_recruit_failure` (game_core) to handle the failed-recruit \
             battle transition; calling advance_turn directly in the reducer \
             cannot be verified for correct operand order or skill-less-wild \
             handling. Body excerpt (first 400 chars): {:?}",
            &body[..body.len().min(400)]
        );

        // Negative: the body must NOT contain a raw inline turn increment.
        // Constructed from parts so the complete literal does not appear
        // verbatim in this test's own text.
        let forbidden = ["turn_number ", "+="].concat();
        assert!(
            !body.contains(forbidden.as_str()),
            "TEETH(ADR-0003 SSOT): attempt_recruit body must NOT contain a raw \
             `turn_number +=` increment; all turn-advance logic is owned by \
             game_core::resolve_recruit_failure (ADR-0003 residual). \
             Body excerpt (first 400 chars): {:?}",
            &body[..body.len().min(400)]
        );
    }

    /// SSOT wiring: the level-up HP heal inside the battle-results write-back
    /// must be computed by `game_core::level_up_healed_hp`, not re-inlined.
    ///
    /// Both checks are scoped to the EXTRACTED body of the function that owns
    /// the heal so that string literals inside this test module never self-match.
    /// The test module lives inside the included source (include_str! captures
    /// the whole file), so searching the full stripped source would cause:
    ///   - the positive needle (`level_up_healed_hp`) to match the failure-message
    ///     text in this very test → false green;
    ///   - the negative needle to match the `inline_frag` variable binding in
    ///     this test → assertion never goes green even after a correct impl.
    ///
    /// Scoping to the production function body eliminates both failure modes.
    ///
    /// RED today: the production body contains the inline formula and no
    /// level_up_healed_hp call.
    #[test]
    fn level_up_heal_is_owned_by_game_core() {
        let stripped = strip_rust_comments(LIB_RS_SOURCE);

        // Scope both checks to the body of the function that owns the heal.
        // The function name is assembled from parts so the complete literal
        // `fn write_back_battle_results(` does not appear in this test's own
        // source text (which is inside the included file) and thereby confuse
        // a hypothetical future caller of extract_fn_body on this test body.
        let heal_fn = ["write_back", "_battle", "_results"].concat();
        let body = extract_fn_body(&stripped, &heal_fn)
            .expect("the battle-results write-back function must exist in lib.rs");

        // Positive: the production body must delegate to game-core.
        // `level_up_healed_hp` does NOT appear in this test's own text, so
        // the assertion has genuine teeth — it only passes when the production
        // body actually contains that call.
        assert!(
            body.contains("level_up_healed_hp"),
            "TEETH(ADR-0003 residual 7c): the battle-results write-back body must \
             call `level_up_healed_hp` (game_core SSOT for level-up HP heal); \
             the heal formula must not be re-inlined. \
             Replace the inline with `game_core::level_up_healed_hp(m.current_hp, bm.max_hp, derived.hp)`."
        );

        // Negative: the inline formula fragment must be absent from the body.
        // Built from parts so the complete literal does not appear verbatim in
        // this test's text — the body slice is restricted to the production
        // function so the binding below is outside the searched region, but
        // constructing from parts keeps the invariant explicit and mirrors the
        // approach used in the attempt_recruit guard above.
        let inline_frag = ["saturating_sub", "(bm.max_hp)"].concat();
        assert!(
            !body.contains(inline_frag.as_str()),
            "TEETH(ADR-0003 residual 7c): the inline heal fragment \
             `saturating_sub(bm.max_hp)` must be removed from the \
             battle-results write-back body once `level_up_healed_hp` is \
             introduced; re-inlining duplicates the SSOT and risks diverging \
             from the game_core rule. Replace with `game_core::level_up_healed_hp(...)`."
        );
    }
}
