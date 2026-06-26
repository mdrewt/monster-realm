//! monster-realm server module (SpacetimeDB 2.6 / `spacetimedb` crate 1.12).
//!
//! The authoritative imperative shell: tables hold the world's truth; reducers are
//! the ONLY writers. Reducers are THIN — validate `ctx.sender` + legality, delegate
//! the rule to `game-core` (the SSOT `apply_move`), write tables; reject with `Err`,
//! never clamp. Movement is **server-paced and per-zone** (ADR-0011/0007): clients
//! buffer intent; a per-zone scheduled `movement_tick` drains one move/character/tick.
//! Time columns are `i64` ms (round-trip `game_core::Millis`). Syntax: crate 1.12.

use game_core::{
    apply_move, apply_xp_gain, battle_xp_reward, load_items, load_skills, load_species,
    load_type_chart, resolve_turn, roll_starter, spawn, validate_content, zone_0, ActionState,
    Affinity, BattleMonster, BattleOutcome, BattleSide, BattleState, CharacterState, Direction,
    Millis, MonsterInstance, MoveInput, NatureKind, SkillDef, StatBlock, StatKind, TileMap,
    TilePos, TurnChoice, TurnVariance, TypeChart, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

const ZONE_0: u32 = 0;
const SPRITE_PLAYER: u32 = 0;
const MAX_NAME_LEN: usize = 24;
const MAX_PARTY_SIZE: u8 = 6;
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

/// 255 sentinel = monster is in the box (not in any party slot).
const PARTY_SLOT_NONE: u8 = 255;

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
fn battle_monster_from_row(
    monster: &Monster,
    species: &SpeciesRow,
    skills: &[SkillRow],
) -> BattleMonster {
    BattleMonster {
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
    }
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row.
fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp;
}

/// Sum the six base stats of a species (for the XP formula).
/// Returns u32 to avoid overflow when base stats are stored as u16.
fn loser_base_stat_total(species: &SpeciesRow) -> u16 {
    // Each base stat is validated <= 255 by validate_content, so the sum fits u16.
    // If the validation range ever widens, widen this return type to u32.
    species.base_hp
        + species.base_attack
        + species.base_defense
        + species.base_speed
        + species.base_sp_attack
        + species.base_sp_defense
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
    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(ch)
}

// --- Reducers -----------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        content_version: 1,
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
        let next = apply_move(&char_state(&row), input, &map, now);
        apply_state(&mut row, &next);
        // position + drained move_queue written in ONE update (atomic, ADR-0013 §B).
        ctx.db.character().entity_id().update(row);
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

/// Start a PvE battle: build BattleMonsters from the player's party and the
/// opponent's party (owned by opponent_identity), create a BattleState, insert
/// the Battle row. Both parties must have at least one conscious party member.
#[spacetimedb::reducer]
pub fn start_battle(
    ctx: &ReducerContext,
    opponent_identity: Identity,
    party_monster_ids: Vec<u64>,
    opponent_monster_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender;

    if party_monster_ids.is_empty() {
        let e = "party_monster_ids must not be empty".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }
    // Reject duplicate monster IDs (prevents double XP write-back).
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
    if opponent_monster_ids.is_empty() {
        let e = "opponent_monster_ids must not be empty".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
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
        team_a.push(battle_monster_from_row(&m, &sp, &skills));
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
        team_b.push(battle_monster_from_row(&m, &sp, &skills));
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

/// After a battle ends (win/loss), write HP back to all party monsters and
/// grant XP to the winner's team.
fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    // Write back HP for player's team.
    for (i, bm) in battle.state.side_a.team.iter().enumerate() {
        let mid = battle.party_monster_ids[i];
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            write_back_hp(&mut m, bm);
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }

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
            let mid = battle.party_monster_ids[i];
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
                        // Heal HP delta from stat growth.
                        m.current_hp = m
                            .current_hp
                            .saturating_add(derived.hp.saturating_sub(bm.max_hp));
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

        let bm: game_core::BattleMonster = battle_monster_from_row(&monster, &species, &skills);

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

        let bm: game_core::BattleMonster = battle_monster_from_row(&monster, &species, &skills);

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

        let bm: game_core::BattleMonster = battle_monster_from_row(&monster, &species, &skills);

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

        let bm: game_core::BattleMonster = battle_monster_from_row(&monster, &species, &one_skill);

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

        // loser_base_stat_total does not exist yet — this test is RED.
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
}
