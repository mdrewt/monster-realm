//! bt-8 gating tests for `tactics.rs` (spec M-battle-tactics, BT8.1-BT8.7).
//!
//! Every test drives the SHIPPED entry points against real rows in the native host
//! (`native_host_tests`): `start_wild_tactical` -> `deploy_units` -> `submit_queue` /
//! `cancel_queue`, the three scheduled reducers fired as the module identity, the disconnect
//! resolver and `on_disconnect`. Mid-battle states the chain cannot reach on demand (a damaged
//! unit, a wild seated in range, the round-2 boundary) are CONSISTENT row edits applied on top of
//! a battle the reducers really started. The oracles are rows and return values; every refusal
//! compares a whole-world snapshot (each registered table as a sorted set of BSATN rows).
//!
//! Fixture conventions:
//! - Party monsters are sturdy (300 HP, 250 defences) and fast (speed 170-200), so no wild hit can
//!   KO them and every party unit precedes every wild in initiative: the chain of a fresh battle
//!   stops at the fastest party member's window before any wild acts.
//! - Content (species, kits, maps, zones, tuning, type chart) comes from game-core's embedded
//!   registries, the same source the shell loads; no content table is seeded.
//! - The native host never deletes a fired one-shot schedule row (the runtime does), so a test
//!   that counts schedule rows after a fire filters the fired row out explicitly.
//! - Encounter seeds are chosen by calling game-core's own `pick_map_index` / `roll_pack_size`.

use super::{
    BattleGcSched, TacticalAdvanceSched, TacticalDeadlineSched, BATTLE_SEED_SALT,
    DEPLOY_WINDOW_UNIT, GC_DELAY_MS,
};
use crate::accounts::{new_account_row, requested_deletion};
use crate::marshal::{encounter_rows_from_table, monster_from_instance, pub_from_monster};
use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::playtest::PlaytestEvent;
use crate::schema::{
    Account, Battle, BattleClock, BattleDeploy, BattleEvent, BattleQueue, BattleSecret,
    BattleSummary, BattleTactical, BattleUnit, BattleWild, BattleWildUnit, Character, Config,
    DeployPick, EncounterRow, EvolutionPathRow, Inventory, Monster, MonsterPub, MoveClassRow,
    Player, PlayerConversation, PlayerFormation, PlayerSession, PlayerWallet, SideRow, StanceRow,
    TradeOffer,
};
use game_core::tactics::{
    load_battle_maps, load_tactics_species, load_tactics_tuning, load_tactics_zones,
    pick_map_index, roll_pack_size, splitmix64, wild_seed, ActionKind, ActionTarget, BattleKind,
    BattleMapDef, EndHow, EventPayload, HaltReason, Hooks, ItemAction, MoveAction, MoveClass,
    Phase, QueuedAction, RecruitAction, Rules, Side, SkillAction, Stance, TacticalBattle,
    TacticalState, TacticsSpeciesDef, TacticsZoneDef, TurnState, UnitState, Validated,
    BATTLE_START_CAP_MS,
};
use game_core::{
    ActionState, BattleOutcome, Direction, Level, MoveInput, Species, StatBlock, TradeStatus,
    TypeChart,
};
use spacetimedb::sats::bsatn::to_vec;
use spacetimedb::{ConnectionId, Identity, ScheduleAt, Timestamp};

// ===========================================================================
// Constants, identities, content
// ===========================================================================

pub(crate) const T0: i64 = 1_750_000_000_000;
/// Spec BT3.9: the PvE idle window AND the PvE deploy window are 300 000 ms.
pub(crate) const PVE_WINDOW_MS: i64 = 300_000;
/// Spec BT8.6: the battle GC fires 24 h after the finish.
pub(crate) const DAY_MS: i64 = 86_400_000;
const CONN_A: u128 = 0xA1;
const CONN_A2: u128 = 0xA2;

/// `(monster_id, species_id, party_slot, stat_speed)`.
pub(crate) type Spec = (u64, u32, u8, u16);
pub(crate) const PAIR: [Spec; 2] = [(11, 1, 0, 200), (12, 3, 1, 190)];
/// Species 3 / 2 / 3: the kits carrying the Diamond-r1 Heavy (skill 6).
const TRIO: [Spec; 3] = [(11, 3, 0, 200), (12, 2, 1, 190), (13, 3, 2, 180)];
pub(crate) const QUAD: [Spec; 4] = [
    (11, 1, 0, 200),
    (12, 3, 1, 190),
    (13, 2, 2, 180),
    (14, 1, 3, 170),
];

pub(crate) fn a() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
pub(crate) fn b() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
pub(crate) fn module() -> Identity {
    Identity::from_byte_array([0x5C; 32])
}
pub(crate) fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}
pub(crate) fn time(ms: i64) -> ScheduleAt {
    ScheduleAt::Time(at(ms))
}

pub(crate) fn species_def(id: u32) -> Species {
    game_core::load_species()
        .expect("species content loads")
        .into_iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("species {id} is in the content"))
}

fn sidecar(species_id: u32) -> TacticsSpeciesDef {
    load_tactics_species()
        .expect("tactics species content loads")
        .into_iter()
        .find(|s| s.species_id == species_id)
        .unwrap_or_else(|| panic!("species {species_id} has a tactics sidecar row"))
}

pub(crate) fn map_def(map_id: u32) -> BattleMapDef {
    load_battle_maps()
        .expect("battle map content loads")
        .into_iter()
        .find(|m| m.id == map_id)
        .map(|m| m.map)
        .unwrap_or_else(|| panic!("battle map {map_id} is in the content"))
}

fn zone0() -> TacticsZoneDef {
    load_tactics_zones()
        .expect("tactics zone content loads")
        .into_iter()
        .find(|z| z.zone_id == 0)
        .expect("zone 0 has a tactics zone row")
}

/// Zone 0's encounter level band for `species_id`.
fn zone0_band(species_id: u32) -> (u8, u8) {
    let table = game_core::load_encounters()
        .expect("encounter content loads")
        .into_iter()
        .find(|t| t.zone_id == 0)
        .expect("zone 0 has an encounter table");
    let entry = table
        .entries
        .iter()
        .find(|e| e.species_id == species_id)
        .unwrap_or_else(|| panic!("species {species_id} spawns in zone 0"));
    (entry.min_level.as_u8(), entry.max_level.as_u8())
}

/// The first encounter seed whose map pick lands `map_id` (and whose natural pack roll is
/// `rolled_pack`, when given) — chosen with game-core's own rules, never a guessed constant.
pub(crate) fn seed_for(map_id: u32, rolled_pack: Option<u8>) -> u64 {
    let zone = zone0();
    (1..100_000u64)
        .find(|&s| {
            let idx = pick_map_index(zone.battle_map_pool.len(), s).expect("zone 0 has a map pool");
            let pack =
                roll_pack_size(&zone.pack_weights, s).expect("zone 0 pack weights are valid");
            zone.battle_map_pool[idx] == map_id && rolled_pack.is_none_or(|p| p == pack)
        })
        .unwrap_or_else(|| panic!("no seed lands map {map_id} with pack {rolled_pack:?}"))
}

fn class_row(class: MoveClass) -> MoveClassRow {
    match class {
        MoveClass::Walk => MoveClassRow::Walk,
        MoveClass::Nimble => MoveClassRow::Nimble,
        MoveClass::Swim => MoveClassRow::Swim,
        MoveClass::Fly => MoveClassRow::Fly,
    }
}

fn stance_row(stance: Stance) -> StanceRow {
    match stance {
        Stance::Aggressive => StanceRow::Aggressive,
        Stance::Territorial => StanceRow::Territorial,
        Stance::Skittish => StanceRow::Skittish,
    }
}

/// A sturdy, fast level-5 party monster built through the shipped constructors.
pub(crate) fn party_monster(owner: Identity, (id, species_id, slot, speed): Spec) -> Monster {
    let species = species_def(species_id);
    let seed = u32::try_from(id).expect("fixture monster ids are small");
    let inst = game_core::build_monster(seed, &species, Level::new(5).expect("5 is a level"));
    let mut m = monster_from_instance(owner, &inst, slot);
    m.monster_id = id;
    m.stat_hp = 300;
    m.current_hp = 300;
    m.stat_defense = 250;
    m.stat_sp_defense = 250;
    m.stat_speed = speed;
    m
}

fn stats_of(m: &Monster) -> StatBlock {
    StatBlock {
        hp: m.stat_hp,
        attack: m.stat_attack,
        defense: m.stat_defense,
        speed: m.stat_speed,
        sp_attack: m.stat_sp_attack,
        sp_defense: m.stat_sp_defense,
    }
}

pub(crate) fn offer(
    trade_id: u64,
    initiator: Identity,
    counterparty: Identity,
    monster_ids: Vec<u64>,
) -> TradeOffer {
    TradeOffer {
        trade_id,
        initiator,
        counterparty,
        initiator_monster_ids: monster_ids,
        initiator_items: Vec::new(),
        initiator_currency: 0,
        counterparty_monster_ids: Vec::new(),
        counterparty_items: Vec::new(),
        counterparty_currency: 0,
        initiator_cards: Vec::new(),
        counterparty_cards: Vec::new(),
        status: TradeStatus::Pending,
        created_at_ms: T0,
    }
}

/// The unit's Light (kit slot 0) bound to `target`.
pub(crate) fn light(u: &BattleUnit, target: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id: u.skill_ids[0],
        target: ActionTarget::Unit(target),
    })
}

/// The unit's Heavy (kit slot 1) bound to `target`.
fn heavy(u: &BattleUnit, target: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id: u.skill_ids[1],
        target: ActionTarget::Unit(target),
    })
}

/// A one-stride Move to `(x, y)`.
fn step(x: u8, y: u8) -> QueuedAction {
    QueuedAction::Move(MoveAction { x, y, strides: 1 })
}

pub(crate) fn pick(monster_id: u64, slot: u8) -> DeployPick {
    DeployPick { monster_id, slot }
}

/// Between-rounds budget: idle, no Guard, First-Stand spent.
pub(crate) fn rest(u: &mut BattleUnit) {
    u.ap = 0;
    u.strides_used = 0;
    u.attacks = 0;
    u.budget_last = None;
    u.guard = false;
    u.first_stand = false;
    u.status = None;
}

// ===========================================================================
// Calls (the shipped entry points, with a chosen sender and clock)
// ===========================================================================

/// `start_wild_tactical` as the grass path would call it (sender = the module).
pub(crate) fn start(fx: &Fixture, player: Identity, seed: u64, pack: Option<u8>, now: i64) -> u64 {
    fx.run_as_at(module(), at(now), |ctx| {
        super::start_wild_tactical(ctx, player, seed, pack)
    })
    .unwrap_or_else(|e| {
        panic!(
            "start_wild_tactical refused: {e}; indexes asked: {:?}",
            fx.requested_indexes()
        )
    })
}

pub(crate) fn submit(
    fx: &Fixture,
    who: Identity,
    now: i64,
    battle_id: u64,
    unit: u32,
    entries: Vec<QueuedAction>,
) -> Result<(), String> {
    fx.run_as_at(who, at(now), |ctx| {
        super::submit_queue(ctx, battle_id, unit, entries)
    })
}

fn cancel(fx: &Fixture, who: Identity, now: i64, battle_id: u64, unit: u32) -> Result<(), String> {
    fx.run_as_at(who, at(now), |ctx| {
        super::cancel_queue(ctx, battle_id, unit)
    })
}

pub(crate) fn deploy(
    fx: &Fixture,
    who: Identity,
    now: i64,
    battle_id: u64,
    picks: Vec<DeployPick>,
) -> Result<(), String> {
    fx.run_as_at(who, at(now), |ctx| {
        super::deploy_units(ctx, battle_id, picks)
    })
}

pub(crate) fn fire_deadline(
    fx: &Fixture,
    now: i64,
    args: TacticalDeadlineSched,
) -> Result<(), String> {
    fx.run_as_at(module(), at(now), |ctx| {
        super::tactical_deadline_fire(ctx, args)
    })
}

pub(crate) fn fire_advance(
    fx: &Fixture,
    now: i64,
    args: TacticalAdvanceSched,
) -> Result<(), String> {
    fx.run_as_at(module(), at(now), |ctx| super::tactical_advance(ctx, args))
}

fn fire_gc(fx: &Fixture, now: i64, args: BattleGcSched) -> Result<(), String> {
    fx.run_as_at(module(), at(now), |ctx| super::battle_gc(ctx, args))
}

pub(crate) fn deadline_args(r: &TacticalDeadlineSched) -> TacticalDeadlineSched {
    TacticalDeadlineSched {
        scheduled_id: r.scheduled_id,
        scheduled_at: r.scheduled_at,
        battle_id: r.battle_id,
        unit_id: r.unit_id,
        window_seq: r.window_seq,
    }
}

pub(crate) fn advance_args(r: &TacticalAdvanceSched) -> TacticalAdvanceSched {
    TacticalAdvanceSched {
        scheduled_id: r.scheduled_id,
        scheduled_at: r.scheduled_at,
        battle_id: r.battle_id,
        round: r.round,
    }
}

fn gc_args(r: &BattleGcSched) -> BattleGcSched {
    BattleGcSched {
        scheduled_id: r.scheduled_id,
        scheduled_at: r.scheduled_at,
        battle_id: r.battle_id,
    }
}

// ===========================================================================
// Snapshots (order-insensitive: each table is the sorted set of its BSATN rows)
// ===========================================================================

pub(crate) type Snap = Vec<(&'static str, Vec<Vec<u8>>)>;

pub(crate) fn enc<T: spacetimedb::Serialize>(value: &T) -> Vec<u8> {
    to_vec(value).expect("a row BSATN-encodes")
}

pub(crate) fn row_set<R: spacetimedb::Serialize>(rows: &[R]) -> Vec<Vec<u8>> {
    let mut set: Vec<Vec<u8>> = rows.iter().map(enc).collect();
    set.sort();
    set
}

/// The names of the tables whose row sets differ.
pub(crate) fn changed(before: &Snap, after: &Snap) -> Vec<&'static str> {
    assert_eq!(before.len(), after.len(), "snapshots cover the same tables");
    before
        .iter()
        .zip(after)
        .filter(|(x, y)| x.1 != y.1)
        .map(|(x, _)| x.0)
        .collect()
}

pub(crate) fn none() -> Vec<&'static str> {
    Vec::new()
}

// ===========================================================================
// The world: every index the shell reads or writes, registered up front
// ===========================================================================

pub(crate) struct World<'a> {
    pub(crate) battles: Handle<'a, Battle, u64>,
    pub(crate) battle_wilds: Handle<'a, BattleWild, u64>,
    pub(crate) monsters: Handle<'a, Monster, u64>,
    pub(crate) pubs: Handle<'a, MonsterPub, u64>,
    pub(crate) inventory: Handle<'a, Inventory, u64>,
    pub(crate) offers: Handle<'a, TradeOffer, u64>,
    pub(crate) accounts: Handle<'a, Account>,
    pub(crate) configs: Handle<'a, Config, u32>,
    pub(crate) players: Handle<'a, Player>,
    pub(crate) characters: Handle<'a, Character, u64>,
    pub(crate) sessions: Handle<'a, PlayerSession>,
    pub(crate) conversations: Handle<'a, PlayerConversation>,
    pub(crate) encounters: Handle<'a, EncounterRow, u32>,
    pub(crate) tacticals: Handle<'a, BattleTactical, u64>,
    pub(crate) units: Handle<'a, BattleUnit, u32>,
    pub(crate) queues: Handle<'a, BattleQueue, u32>,
    pub(crate) deploys: Handle<'a, BattleDeploy, u64>,
    pub(crate) clocks: Handle<'a, BattleClock, u64>,
    pub(crate) secrets: Handle<'a, BattleSecret, u64>,
    pub(crate) wild_units: Handle<'a, BattleWildUnit, u64>,
    pub(crate) events: Handle<'a, BattleEvent, u64>,
    pub(crate) summaries: Handle<'a, BattleSummary, u64>,
    pub(crate) formations: Handle<'a, PlayerFormation>,
    pub(crate) deadlines: Handle<'a, TacticalDeadlineSched, u64>,
    pub(crate) advances: Handle<'a, TacticalAdvanceSched, u64>,
    pub(crate) gcs: Handle<'a, BattleGcSched, u64>,
    /// bt-9: the settlement's currency faucet writes it (`economy::grant_currency`).
    pub(crate) wallets: Handle<'a, PlayerWallet>,
    /// bt-9: the tactical recruit glue's H1/H2 row (`playtest::record_recruit_event`).
    pub(crate) playtests: Handle<'a, PlaytestEvent, u64>,
}

pub(crate) fn world(fx: &Fixture) -> World<'_> {
    fx.set_database_identity(module());
    // Secondary indexes first (the World handle below is each table's primary key).
    let _ = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
    let _ = fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity);
    let _ = fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator);
    let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
    let _ = fx.table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
        r.connection_id
    });
    let _ = fx.table_keyed::<BattleTactical, u32>("battle_tactical", "map_id", |r| r.map_id);
    let _ = fx.table_keyed::<BattleUnit, u64>("battle_unit", "battle_id", |r| r.battle_id);
    let _ = fx.table_keyed::<BattleQueue, u64>("battle_queue", "battle_id", |r| r.battle_id);
    let _ = fx.table::<BattleQueue>("battle_queue", "owner", |r| r.owner);
    let _ = fx.table_keyed::<BattleDeploy, u64>("battle_deploy", "battle_id", |r| r.battle_id);
    let _ = fx.table::<BattleDeploy>("battle_deploy", "owner", |r| r.owner);
    let _ = fx.table_keyed::<BattleClock, u64>("battle_clock", "battle_id", |r| r.battle_id);
    let _ = fx.table::<BattleClock>("battle_clock", "player", |r| r.player);
    let _ = fx.table_keyed::<BattleWildUnit, u64>("battle_wild_unit", "battle_id", |r| r.battle_id);
    let _ = fx.table_keyed::<BattleEvent, u64>("battle_event", "battle_id", |r| r.battle_id);
    let _ = fx.table::<BattleSummary>("battle_summary", "player_identity", |r| r.player_identity);
    let _ = fx.table::<BattleSummary>("battle_summary", "opponent_identity", |r| {
        r.opponent_identity
    });
    let _ =
        fx.table_keyed::<TacticalDeadlineSched, u64>("tactical_deadline_sched", "battle_id", |r| {
            r.battle_id
        });
    let _ =
        fx.table_keyed::<TacticalAdvanceSched, u64>("tactical_advance_sched", "battle_id", |r| {
            r.battle_id
        });
    let _ = fx.table_keyed::<BattleGcSched, u64>("battle_gc_sched", "battle_id", |r| r.battle_id);
    // bt-9: the settlement's evolution check reads the edges out of a species (none seeded).
    let _ = fx
        .table_keyed::<EvolutionPathRow, u32>("evolution_path", "from_species", |r| r.from_species);
    let w = World {
        battles: fx
            .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
            .writable()
            .unique()
            .auto_inc(|r| r.battle_id, |r, id| r.battle_id = id),
        battle_wilds: fx
            .table_keyed::<BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
            .writable()
            .unique(),
        monsters: fx
            .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
            .writable()
            .unique()
            // bt-9: a tactical recruit inserts the rebuilt monster (auto_inc id).
            .auto_inc(|r| r.monster_id, |r, id| r.monster_id = id),
        pubs: fx
            .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
            .writable()
            .unique(),
        inventory: fx
            .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
            .writable()
            .unique()
            .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id),
        offers: fx
            .table_keyed::<TradeOffer, u64>("trade_offer", "trade_id", |r| r.trade_id)
            .writable()
            .unique(),
        accounts: fx
            .table::<Account>("account", "identity", |r| r.identity)
            .unique(),
        configs: fx
            .table_keyed::<Config, u32>("config", "id", |r| r.id)
            .unique(),
        players: fx
            .table::<Player>("player", "identity", |r| r.identity)
            .writable()
            .unique(),
        characters: fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .writable()
            .unique(),
        sessions: fx
            .table::<PlayerSession>("player_session", "identity", |r| r.identity)
            .writable(),
        conversations: fx
            .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                r.owner_identity
            })
            .writable()
            .unique(),
        encounters: fx
            .table_keyed::<EncounterRow, u32>("encounter", "zone_id", |r| r.zone_id)
            .unique(),
        tacticals: fx
            .table_keyed::<BattleTactical, u64>("battle_tactical", "battle_id", |r| r.battle_id)
            .writable()
            .unique(),
        units: fx
            .table_keyed::<BattleUnit, u32>("battle_unit", "unit_id", |r| r.unit_id)
            .writable()
            .unique()
            .auto_inc(
                |r| u64::from(r.unit_id),
                |r, id| r.unit_id = u32::try_from(id).expect("unit ids fit u32"),
            ),
        queues: fx
            .table_keyed::<BattleQueue, u32>("battle_queue", "unit_id", |r| r.unit_id)
            .writable()
            .unique(),
        deploys: fx
            .table_keyed::<BattleDeploy, u64>("battle_deploy", "deploy_id", |r| r.deploy_id)
            .writable()
            .unique()
            .auto_inc(|r| r.deploy_id, |r, id| r.deploy_id = id),
        clocks: fx
            .table_keyed::<BattleClock, u64>("battle_clock", "clock_id", |r| r.clock_id)
            .writable()
            .unique()
            .auto_inc(|r| r.clock_id, |r, id| r.clock_id = id),
        secrets: fx
            .table_keyed::<BattleSecret, u64>("battle_secret", "battle_id", |r| r.battle_id)
            .writable()
            .unique(),
        wild_units: fx
            .table_keyed::<BattleWildUnit, u64>("battle_wild_unit", "wild_unit_id", |r| {
                r.wild_unit_id
            })
            .writable()
            .unique()
            .auto_inc(|r| r.wild_unit_id, |r, id| r.wild_unit_id = id),
        events: fx
            .table_keyed::<BattleEvent, u64>("battle_event", "event_id", |r| r.event_id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.event_id, |r, id| r.event_id = id),
        summaries: fx
            .table_keyed::<BattleSummary, u64>("battle_summary", "battle_id", |r| r.battle_id)
            .writable()
            .unique(),
        formations: fx
            .table::<PlayerFormation>("player_formation", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique(),
        deadlines: fx
            .table_keyed::<TacticalDeadlineSched, u64>(
                "tactical_deadline_sched",
                "scheduled_id",
                |r| r.scheduled_id,
            )
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id),
        advances: fx
            .table_keyed::<TacticalAdvanceSched, u64>(
                "tactical_advance_sched",
                "scheduled_id",
                |r| r.scheduled_id,
            )
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id),
        gcs: fx
            .table_keyed::<BattleGcSched, u64>("battle_gc_sched", "scheduled_id", |r| {
                r.scheduled_id
            })
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id),
        wallets: fx
            .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique(),
        playtests: fx
            .table_keyed::<PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.event_id, |r, id| r.event_id = id),
    };
    w.configs.seed(&Config {
        id: 0,
        content_version: crate::CONTENT_VERSION,
        owner_identity: module(),
    });
    for table in game_core::load_encounters().expect("encounter content loads") {
        w.encounters.seed(&encounter_rows_from_table(&table));
    }
    w
}

impl World<'_> {
    /// A joined player standing in zone 0.
    pub(crate) fn join(&self, who: Identity, entity_id: u64) {
        self.players.seed(&Player {
            identity: who,
            entity_id,
            name: format!("p{entity_id}"),
            online: true,
            last_input_seq: 0,
        });
        self.characters.seed(&Character {
            entity_id,
            zone_id: crate::ZONE_0,
            tile_x: 0,
            tile_y: 0,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: Vec::new(),
        });
    }

    pub(crate) fn seed_monster(&self, m: &Monster) {
        self.pubs.seed(&pub_from_monster(m, 0));
        self.monsters.seed(m);
    }

    pub(crate) fn seed_party(&self, owner: Identity, specs: &[Spec]) {
        for &spec in specs {
            self.seed_monster(&party_monster(owner, spec));
        }
    }

    pub(crate) fn snapshot(&self) -> Snap {
        vec![
            ("battle", row_set(&self.battles.rows())),
            ("battle_wild", row_set(&self.battle_wilds.rows())),
            ("monster", row_set(&self.monsters.rows())),
            ("monster_pub", row_set(&self.pubs.rows())),
            ("inventory", row_set(&self.inventory.rows())),
            ("trade_offer", row_set(&self.offers.rows())),
            ("account", row_set(&self.accounts.rows())),
            ("config", row_set(&self.configs.rows())),
            ("player", row_set(&self.players.rows())),
            ("character", row_set(&self.characters.rows())),
            ("player_session", row_set(&self.sessions.rows())),
            ("player_conversation", row_set(&self.conversations.rows())),
            ("encounter", row_set(&self.encounters.rows())),
            ("battle_tactical", row_set(&self.tacticals.rows())),
            ("battle_unit", row_set(&self.units.rows())),
            ("battle_queue", row_set(&self.queues.rows())),
            ("battle_deploy", row_set(&self.deploys.rows())),
            ("battle_clock", row_set(&self.clocks.rows())),
            ("battle_secret", row_set(&self.secrets.rows())),
            ("battle_wild_unit", row_set(&self.wild_units.rows())),
            ("battle_event", row_set(&self.events.rows())),
            ("battle_summary", row_set(&self.summaries.rows())),
            ("player_formation", row_set(&self.formations.rows())),
            ("tactical_deadline_sched", row_set(&self.deadlines.rows())),
            ("tactical_advance_sched", row_set(&self.advances.rows())),
            ("battle_gc_sched", row_set(&self.gcs.rows())),
            ("player_wallet", row_set(&self.wallets.rows())),
            ("playtest_event", row_set(&self.playtests.rows())),
        ]
    }

    pub(crate) fn anchor(&self, id: u64) -> Option<Battle> {
        self.battles.rows().into_iter().find(|r| r.battle_id == id)
    }

    pub(crate) fn try_tactical(&self, id: u64) -> Option<BattleTactical> {
        self.tacticals
            .rows()
            .into_iter()
            .find(|r| r.battle_id == id)
    }

    pub(crate) fn tactical(&self, id: u64) -> BattleTactical {
        self.try_tactical(id)
            .unwrap_or_else(|| panic!("battle {id} has a battle_tactical row"))
    }

    pub(crate) fn secret(&self, id: u64) -> BattleSecret {
        self.secrets
            .rows()
            .into_iter()
            .find(|r| r.battle_id == id)
            .unwrap_or_else(|| panic!("battle {id} has a battle_secret row"))
    }

    /// The battle's ONE side-A clock row.
    pub(crate) fn clock(&self, id: u64) -> BattleClock {
        let mut rows: Vec<BattleClock> = self
            .clocks
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect();
        assert_eq!(
            rows.len(),
            1,
            "battle {id}: exactly one battle_clock row (side A)"
        );
        rows.remove(0)
    }

    pub(crate) fn unit(&self, unit_id: u32) -> BattleUnit {
        self.units
            .rows()
            .into_iter()
            .find(|r| r.unit_id == unit_id)
            .unwrap_or_else(|| panic!("battle_unit {unit_id} exists"))
    }

    pub(crate) fn units_of(&self, id: u64) -> Vec<BattleUnit> {
        self.units
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    /// One side's units in slot order.
    pub(crate) fn side_units(&self, id: u64, side: SideRow) -> Vec<BattleUnit> {
        let mut rows: Vec<BattleUnit> = self
            .units_of(id)
            .into_iter()
            .filter(|r| r.side == side)
            .collect();
        rows.sort_by_key(|r| r.slot);
        rows
    }

    pub(crate) fn queues_of(&self, id: u64) -> Vec<BattleQueue> {
        self.queues
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    fn deploys_of(&self, id: u64) -> Vec<BattleDeploy> {
        self.deploys
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    pub(crate) fn wild_units_of(&self, id: u64) -> Vec<BattleWildUnit> {
        let mut rows: Vec<BattleWildUnit> = self
            .wild_units
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect();
        rows.sort_by_key(|r| r.wild_index);
        rows
    }

    pub(crate) fn deadlines_of(&self, id: u64) -> Vec<TacticalDeadlineSched> {
        self.deadlines
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    pub(crate) fn only_deadline(&self, id: u64) -> TacticalDeadlineSched {
        let mut rows = self.deadlines_of(id);
        assert_eq!(rows.len(), 1, "battle {id}: exactly one deadline row");
        rows.remove(0)
    }

    fn advances_of(&self, id: u64) -> Vec<TacticalAdvanceSched> {
        self.advances
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    pub(crate) fn gcs_of(&self, id: u64) -> Vec<BattleGcSched> {
        self.gcs
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect()
    }

    /// The battle's transcript in `seq` order.
    pub(crate) fn events_of(&self, id: u64) -> Vec<BattleEvent> {
        let mut rows: Vec<BattleEvent> = self
            .events
            .rows()
            .into_iter()
            .filter(|r| r.battle_id == id)
            .collect();
        rows.sort_by_key(|r| r.seq);
        rows
    }

    pub(crate) fn monster(&self, id: u64) -> Monster {
        self.monsters
            .rows()
            .into_iter()
            .find(|r| r.monster_id == id)
            .unwrap_or_else(|| panic!("monster {id} exists"))
    }

    pub(crate) fn monster_pub(&self, id: u64) -> MonsterPub {
        self.pubs
            .rows()
            .into_iter()
            .find(|r| r.monster_id == id)
            .unwrap_or_else(|| panic!("monster_pub {id} exists"))
    }

    fn formation_of(&self, who: Identity) -> Option<Vec<u64>> {
        self.formations
            .rows()
            .into_iter()
            .find(|r| r.owner_identity == who)
            .map(|r| r.monster_ids)
    }

    /// Row counts of every per-battle table the 24 h GC sweeps.
    pub(crate) fn per_battle(&self, id: u64) -> Vec<(&'static str, usize)> {
        vec![
            ("battle_event", self.events_of(id).len()),
            ("battle_unit", self.units_of(id).len()),
            ("battle_queue", self.queues_of(id).len()),
            (
                "battle_clock",
                self.clocks
                    .rows()
                    .iter()
                    .filter(|r| r.battle_id == id)
                    .count(),
            ),
            (
                "battle_secret",
                self.secrets
                    .rows()
                    .iter()
                    .filter(|r| r.battle_id == id)
                    .count(),
            ),
            ("battle_wild_unit", self.wild_units_of(id).len()),
            ("battle_deploy", self.deploys_of(id).len()),
            ("tactical_deadline_sched", self.deadlines_of(id).len()),
            ("tactical_advance_sched", self.advances_of(id).len()),
        ]
    }

    pub(crate) fn edit_unit(&self, unit_id: u32, f: impl FnOnce(&mut BattleUnit)) {
        let mut row = self.unit(unit_id);
        assert_eq!(
            self.units.remove(unit_id),
            1,
            "unit {unit_id} edited in place"
        );
        f(&mut row);
        self.units.seed(&row);
    }

    pub(crate) fn edit_tactical(&self, id: u64, f: impl FnOnce(&mut BattleTactical)) {
        let mut row = self.tactical(id);
        assert_eq!(
            self.tacticals.remove(id),
            1,
            "battle_tactical {id} edited in place"
        );
        f(&mut row);
        self.tacticals.seed(&row);
    }

    pub(crate) fn edit_clock(&self, id: u64, f: impl FnOnce(&mut BattleClock)) {
        let mut row = self.clock(id);
        assert_eq!(
            self.clocks.remove(row.clock_id),
            1,
            "battle {id}'s clock edited in place"
        );
        f(&mut row);
        self.clocks.seed(&row);
    }
}

// ===========================================================================
// Scenarios built through the real reducers
// ===========================================================================

/// A pack-1 battle on map 1 for A's `PAIR`, started at `T0`: `u1` (the faster) holds the first
/// window, `u2` has not started its turn, the wild has not acted.
pub(crate) struct Live {
    pub(crate) id: u64,
    pub(crate) u1: u32,
    pub(crate) u2: u32,
    pub(crate) wild: u32,
}

pub(crate) fn live_pair(fx: &Fixture, w: &World<'_>) -> Live {
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(fx, a(), seed_for(1, Some(1)), None, T0);
    let players = w.side_units(id, SideRow::A);
    let wilds = w.side_units(id, SideRow::B);
    assert_eq!(
        (players.len(), wilds.len()),
        (2, 1),
        "a pack-1 start fields the whole PAIR and one wild"
    );
    let live = Live {
        id,
        u1: players[0].unit_id,
        u2: players[1].unit_id,
        wild: wilds[0].unit_id,
    };
    assert_eq!(
        w.tactical(id).turn_state,
        TurnState::Waiting(live.u1),
        "the fastest party member holds the first window"
    );
    live
}

/// A forced pack-2 battle on map 4 for A's `PAIR`, Deploying since `T0`.
pub(crate) fn deploying_pair(fx: &Fixture, w: &World<'_>) -> u64 {
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(fx, a(), seed_for(4, None), Some(2), T0);
    assert_eq!(
        w.tactical(id).phase,
        Phase::Deploying,
        "a forced pack of two starts Deploying"
    );
    id
}

/// Seat `target` two tiles south of `attacker` (every shipped Light reaches distance 2).
pub(crate) fn seat_in_light_range(w: &World<'_>, attacker: u32, target: u32) {
    let from = w.unit(attacker);
    w.edit_unit(target, |t| {
        t.x = from.x;
        t.y = from.y + 2;
    });
}

// ===========================================================================
// The engine oracle for the round trip: the same game-core step, replayed in-test
// ===========================================================================

/// Hooks for a step that never reaches a wild turn or a delegated entry.
struct Oracle;

impl Hooks for Oracle {
    fn item_count(&self, _unit: u32, _item_id: u32) -> u32 {
        0
    }
    fn take_item(&mut self, _unit: u32, _item_id: u32) -> bool {
        false
    }
    fn recruit_headroom(&self, _unit: u32) -> bool {
        false
    }
    fn plan_ai(&self, _state: &TacticalState, _unit: u32) -> Vec<QueuedAction> {
        panic!("the oracle replays only steps that stop before any wild turn")
    }
    fn validate_delegated(
        &self,
        _state: &TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Result<(), HaltReason> {
        Err(HaltReason::NotAllowed(ActionKind::Item))
    }
    fn resolve_delegated(
        &mut self,
        _state: &mut TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Vec<EventPayload> {
        Vec::new()
    }
}

/// `before` stepped by the pure engine exactly as `submit_queue` asks it to.
fn engine_step(
    before: &TacticalBattle,
    now: i64,
    unit: u32,
    entries: Vec<QueuedAction>,
) -> TacticalBattle {
    let tuning = load_tactics_tuning().expect("tactics tuning content loads");
    let chart = TypeChart::new(&game_core::load_type_chart().expect("type chart content loads"));
    let rules = Rules {
        chart: &chart,
        tuning: &tuning,
    };
    let mut want = before.clone();
    want.submit_queue(now, Side::A, unit, entries, &rules, &mut Oracle)
        .expect("the oracle replays a legal step");
    want
}

pub(crate) fn loaded(fx: &Fixture, id: u64, now: i64) -> TacticalBattle {
    super::load(&fx.ctx_at(at(now)), id)
        .unwrap_or_else(|e| panic!("load({id}) refused: {e}"))
        .tb
}

/// `state.queued` is a derived mirror of `plans` (never stored), so it is compared through
/// `plans` only.
fn assert_same_battle(mut got: TacticalBattle, mut want: TacticalBattle, step: &str) {
    got.state.queued.clear();
    want.state.queued.clear();
    assert_eq!(
        got, want,
        "{step}: load(store(step(tb))) must equal step(tb), column for column"
    );
}

// ===========================================================================
// BT8.1 — client reducers: identity from ctx.sender(), re-validation, refusal before any write
// ===========================================================================

#[test]
fn submit_queue_refuses_a_non_owner_and_leaves_the_store_untouched_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    let got = submit(
        &fx,
        b(),
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    );
    assert_eq!(got, Err("not owner".to_string()));
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "a refused submit writes nothing"
    );
}

#[test]
fn submit_and_cancel_refuse_a_missing_battle_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    assert_eq!(
        submit(
            &fx,
            a(),
            T0 + 1_000,
            4_242,
            live.u1,
            vec![QueuedAction::EndTurn]
        ),
        Err("battle not found".to_string())
    );
    assert_eq!(
        cancel(&fx, a(), T0 + 1_000, 4_242, live.u2),
        Err("battle not found".to_string())
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn submit_queue_refuses_a_unit_of_another_battle_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.join(b(), 2);
    w.seed_party(b(), &[(21, 1, 0, 200), (22, 3, 1, 190)]);
    let theirs = start(&fx, b(), seed_for(1, Some(1)), None, T0);
    let foreign = w.side_units(theirs, SideRow::A)[0].unit_id;
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        foreign,
        vec![QueuedAction::EndTurn],
    );
    assert_eq!(got, Err(format!("unit {foreign} not in battle")));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn submit_queue_refuses_a_wild_unit_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    let err = submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        live.wild,
        vec![QueuedAction::EndTurn],
    )
    .expect_err("a wild unit never holds a player plan");
    assert!(
        err.starts_with("submit_queue: Not"),
        "the typed engine refusal (NotYourUnit / NotPlayerOwned), got {err:?}"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn submit_queue_refuses_a_fainted_unit_with_the_typed_act_error_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let u2 = live.u2;
    w.edit_unit(u2, |u| {
        u.cur_hp = 0;
        u.state = UnitState::Fainted;
    });
    w.edit_tactical(live.id, |t| t.initiative.retain(|&u| u != u2));
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        u2,
        vec![QueuedAction::EndTurn],
    );
    assert_eq!(got, Err(format!("submit_queue: Act(Fainted({u2}))")));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn submit_queue_refuses_an_unaffordable_prequeue_and_stores_no_row_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let u2 = w.unit(live.u2);
    let plan = vec![
        heavy(&u2, live.wild),
        heavy(&u2, live.wild),
        heavy(&u2, live.wild),
    ];
    let before = w.snapshot();
    let err = submit(&fx, a(), T0 + 1_000, live.id, live.u2, plan)
        .expect_err("three Heavies (4, then 4 + 2 Exert, ...) never fit 6 AP");
    assert!(
        err.starts_with("submit_queue: Economy("),
        "the typed economy refusal, got {err:?}"
    );
    assert!(
        w.queues_of(live.id).is_empty(),
        "an unaffordable plan is never stored"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn submit_queue_refuses_more_than_four_entries_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn; 5],
    );
    assert_eq!(got, Err("too many entries".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

/// Re-pinned by bt-9 (spec BT9.2): Recruit became legal, so only `Item` entries are still refused
/// at submit (R-bt-8-ITEMRULE); a LIVE Recruit is judged by the engine's own gate (a wild that is
/// not adjacent is the typed `NotAdjacent`), a pre-queued one is stored and judged at pop.
#[test]
fn submit_queue_refuses_items_and_a_far_live_recruit_but_stores_a_prequeued_one_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let item = QueuedAction::Item(ItemAction {
        item_id: 1,
        target: ActionTarget::SelfTarget,
    });
    let recruit = QueuedAction::Recruit(RecruitAction {
        target: live.wild,
        bait: None,
    });
    let before = w.snapshot();
    for (label, unit) in [("live Item", live.u1), ("pre-queued Item", live.u2)] {
        let got = submit(&fx, a(), T0 + 1_000, live.id, unit, vec![item]);
        assert!(
            got.is_err(),
            "{label}: items stay refused at submit, got {got:?}"
        );
        assert_eq!(
            changed(&before, &w.snapshot()),
            none(),
            "{label}: nothing stored"
        );
    }
    let got = submit(&fx, a(), T0 + 1_000, live.id, live.u1, vec![recruit]);
    assert_eq!(
        got,
        Err(format!(
            "submit_queue: InvalidNow {{ reason: NotAdjacent {{ target: {} }} }}",
            live.wild
        )),
        "a live Recruit of a wild four tiles away is the engine's typed refusal"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "a refused live Recruit writes nothing"
    );
    submit(&fx, a(), T0 + 1_000, live.id, live.u2, vec![recruit])
        .expect("a pre-queued Recruit is legal (adjacency is judged at pop)");
    assert_eq!(changed(&before, &w.snapshot()), vec!["battle_queue"]);
    let stored: Vec<(u32, Vec<QueuedAction>)> = w
        .queues_of(live.id)
        .into_iter()
        .map(|q| (q.unit_id, q.entries))
        .collect();
    assert_eq!(
        stored,
        vec![(live.u2, vec![recruit, QueuedAction::EndTurn])],
        "the stored plan is the Recruit plus the appended EndTurn"
    );
}

#[test]
fn submit_and_cancel_refuse_a_deploying_battle_as_not_active_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pair(&fx, &w);
    let before = w.snapshot();
    assert_eq!(
        submit(&fx, a(), T0 + 1_000, id, 1, vec![QueuedAction::EndTurn]),
        Err("battle is not active".to_string())
    );
    assert_eq!(
        cancel(&fx, a(), T0 + 1_000, id, 1),
        Err("battle is not active".to_string())
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn cancel_queue_after_turn_start_consumed_the_plan_is_already_acting_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    assert_eq!(
        cancel(&fx, a(), T0 + 1_000, live.id, live.u1),
        Err("cancel_queue: AlreadyActing".to_string()),
        "the waiting unit's TurnStart already consumed any READY row"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn cancel_queue_refuses_a_non_owner_and_the_owners_row_survives_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("A pre-queues its own unit");
    assert_eq!(w.queues_of(live.id).len(), 1);
    let before = w.snapshot();
    assert_eq!(
        cancel(&fx, b(), T0 + 2_000, live.id, live.u2),
        Err("not owner".to_string())
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "the owner's READY row survives a stranger's cancel"
    );
}

#[test]
fn cancel_queue_for_a_unit_with_no_plan_that_has_not_acted_is_no_plan_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    assert_eq!(
        cancel(&fx, a(), T0 + 1_000, live.id, live.u2),
        Err("cancel_queue: NoPlan".to_string())
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

/// A Deploying pack-2 battle for A's PAIR plus a fainted party member (13), a boxed monster
/// (19) and B's monster (27); one illegal pick set is offered and must be refused before any
/// write.
fn assert_deploy_refused(
    label: &str,
    caller: Identity,
    picks: Vec<DeployPick>,
    want: &str,
    traded: Option<u64>,
) {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let mut fainted = party_monster(a(), (13, 3, 2, 180));
    fainted.current_hp = 0;
    w.seed_monster(&fainted);
    w.seed_monster(&party_monster(a(), (19, 1, crate::PARTY_SLOT_NONE, 160)));
    w.seed_monster(&party_monster(b(), (27, 1, 0, 150)));
    let id = start(&fx, a(), seed_for(4, None), Some(2), T0);
    if let Some(mid) = traded {
        w.offers.seed(&offer(1, a(), b(), vec![mid]));
    }
    let before = w.snapshot();
    let got = deploy(&fx, caller, T0 + 1_000, id, picks);
    assert_eq!(got, Err(want.to_string()), "{label}");
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "{label}: a refused deploy writes nothing"
    );
}

#[test]
fn deploy_units_refuses_every_illegal_pick_set_before_any_write_bt8_1() {
    assert_deploy_refused("non-owner", b(), vec![pick(11, 0)], "not owner", None);
    assert_deploy_refused(
        "fainted pick",
        a(),
        vec![pick(13, 0)],
        "monster 13 is fainted",
        None,
    );
    assert_deploy_refused(
        "boxed monster",
        a(),
        vec![pick(19, 0)],
        "monster 19 not in party",
        None,
    );
    assert_deploy_refused(
        "another player's monster",
        a(),
        vec![pick(27, 0)],
        "monster 27 not owned by player",
        None,
    );
    assert_deploy_refused(
        "pick in an active trade",
        a(),
        vec![pick(12, 0)],
        "monster is in an active trade",
        Some(12),
    );
    assert_deploy_refused(
        "duplicate slot",
        a(),
        vec![pick(11, 0), pick(12, 0)],
        "duplicate slot 0",
        None,
    );
    assert_deploy_refused(
        "duplicate monster",
        a(),
        vec![pick(11, 0), pick(11, 1)],
        "duplicate monster_id 11",
        None,
    );
    assert_deploy_refused("no picks", a(), Vec::new(), "no picks", None);
    assert_deploy_refused(
        "four picks",
        a(),
        vec![pick(11, 0), pick(12, 1), pick(13, 2), pick(19, 0)],
        "too many picks",
        None,
    );
    assert_deploy_refused(
        "slot past the spawn row",
        a(),
        vec![pick(11, 3)],
        "slot 3 out of range",
        None,
    );
}

#[test]
fn deploy_units_refuses_a_battle_that_is_already_active_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    assert_eq!(
        deploy(&fx, a(), T0 + 1_000, live.id, vec![pick(11, 0)]),
        Err("battle is not deploying".to_string())
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn prequeue_stores_exactly_the_entries_plus_end_turn_and_nothing_else_moves_bt8_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let u2 = w.unit(live.u2);
    let t1 = T0 + 5_000;
    let before = w.snapshot();
    submit(&fx, a(), t1, live.id, live.u2, vec![light(&u2, live.wild)])
        .expect("an affordable pre-queue for a unit that is not waiting is stored");
    assert_eq!(
        changed(&before, &w.snapshot()),
        vec!["battle_queue"],
        "a pre-queue writes its READY row and nothing else: no clock, no deadline, no event"
    );
    let rows = w.queues_of(live.id);
    assert_eq!(rows.len(), 1);
    let q = &rows[0];
    assert_eq!(
        (q.unit_id, q.battle_id, q.owner, q.submitted_at_ms),
        (live.u2, live.id, a(), t1)
    );
    assert_eq!(
        q.entries,
        vec![light(&u2, live.wild), QueuedAction::EndTurn],
        "the stored plan is the entries plus the appended EndTurn"
    );
}

#[test]
fn deletion_gate_admits_a_battle_opened_before_the_request_and_refuses_one_opened_after_bt8_1() {
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        w.accounts.seed(&requested_deletion(
            new_account_row(a(), String::new(), 0),
            T0 + 1_000,
        ));
        submit(
            &fx,
            a(),
            T0 + 2_000,
            live.id,
            live.u2,
            vec![QueuedAction::EndTurn],
        )
        .expect("a battle opened BEFORE the deletion request stays completable");
        assert_eq!(w.queues_of(live.id).len(), 1);
    }
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        w.accounts.seed(&requested_deletion(
            new_account_row(a(), String::new(), 0),
            T0 - 1_000,
        ));
        let before = w.snapshot();
        let got = submit(
            &fx,
            a(),
            T0 + 2_000,
            live.id,
            live.u2,
            vec![QueuedAction::EndTurn],
        );
        assert_eq!(
            got,
            Err(crate::guards::REJECT_DELETION_GATED.to_string()),
            "a battle opened AFTER the request is refused with the gate text"
        );
        assert_eq!(changed(&before, &w.snapshot()), none());
    }
}

// ===========================================================================
// BT8.2 — start_wild_tactical, deploy, formation, hydration
// ===========================================================================

#[test]
fn pack_of_one_start_inserts_every_row_and_runs_the_chain_to_the_first_player_window_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let seed = seed_for(1, Some(1));
    let id = start(&fx, a(), seed, None, T0);
    let map = map_def(1);

    // The anchor: Ongoing, wild opponent, the WHOLE party on side A, one wild on side B.
    let anchor = w.anchor(id).expect("start inserts the anchor battle row");
    assert_eq!(
        (anchor.player_identity, anchor.opponent_identity),
        (a(), crate::WILD_IDENTITY)
    );
    assert_eq!(anchor.state.outcome, BattleOutcome::Ongoing);
    assert_eq!(anchor.party_monster_ids, vec![11, 12]);
    assert!(
        anchor.opponent_monster_ids.is_empty(),
        "a wild has no monster row"
    );
    assert_eq!(anchor.created_at_ms, T0);
    let side_a_hp: Vec<u16> = anchor
        .state
        .side_a
        .team
        .iter()
        .map(|m| m.current_hp)
        .collect();
    assert_eq!(
        side_a_hp,
        vec![w.monster(11).current_hp, w.monster(12).current_hp]
    );
    assert_eq!(anchor.state.side_b.team.len(), 1);
    assert!(
        w.battle_wilds.rows().is_empty(),
        "the legacy battle_wild sidecar is never written"
    );

    // battle_tactical.
    let t = w.tactical(id);
    assert_eq!(
        (t.kind, t.format, t.map_id, t.content_version),
        (BattleKind::Wild, 0, 1, crate::CONTENT_VERSION)
    );
    assert!(zone0().battle_map_pool.contains(&t.map_id));
    assert_eq!(
        (t.phase, t.round, t.tie_priority_side),
        (Phase::Active, 1, SideRow::A)
    );

    // battle_secret: a salted roll stream, nothing drawn yet.
    let secret = w.secret(id);
    assert_eq!(secret.seed, splitmix64(seed ^ BATTLE_SEED_SALT));
    assert_ne!(
        secret.seed, seed,
        "the roll stream is never the raw encounter seed"
    );
    assert_eq!(
        secret.action_seq, 0,
        "no roll is drawn before the first window"
    );

    // battle_wild_unit.
    let wild_rows = w.wild_units_of(id);
    assert_eq!(wild_rows.len(), 1);
    let wr = &wild_rows[0];
    assert_eq!(
        (wr.wild_index, wr.individuality_seed),
        (0, wild_seed(seed, 0))
    );
    assert!(
        [1, 2, 3].contains(&wr.species_id),
        "a zone-0 wild is species 1, 2 or 3, got {}",
        wr.species_id
    );
    let (lo, hi) = zone0_band(wr.species_id);
    assert!(
        (lo..=hi).contains(&wr.level),
        "wild level {} inside its band {lo}..={hi}",
        wr.level
    );

    // Player units: the two conscious party members in party order, on spawn_a.
    let players = w.side_units(id, SideRow::A);
    assert_eq!(players.len(), 2);
    for (i, (u, mid)) in players.iter().zip([11u64, 12]).enumerate() {
        let m = w.monster(mid);
        let car = sidecar(m.species_id);
        let slot = u8::try_from(i).expect("slot fits u8");
        assert_eq!(
            (u.owner, u.slot, u.monster_id, u.wild_index),
            (Some(a()), slot, Some(mid), None),
            "player unit {i}"
        );
        assert_eq!(
            (u.species_id, u.level, u.affinity),
            (m.species_id, m.level, species_def(m.species_id).affinity),
            "player unit {i}"
        );
        assert_eq!(
            (u.x, u.y),
            (map.spawn_a[i].x, map.spawn_a[i].y),
            "player unit {i}"
        );
        assert_eq!(
            (u.cur_hp, u.stats),
            (m.current_hp, stats_of(&m)),
            "player unit {i}"
        );
        assert_eq!(
            (u.skill_ids.clone(), u.movement, u.stance),
            (car.kit.to_vec(), class_row(car.movement), None),
            "player unit {i}"
        );
        assert_eq!(
            (u.state, u.guard, u.status),
            (UnitState::Active, false, None),
            "player unit {i}"
        );
    }
    let (first, second) = (&players[0], &players[1]);
    assert_eq!(t.turn_state, TurnState::Waiting(first.unit_id));
    assert_eq!(
        (first.ap, first.first_stand),
        (6, false),
        "TurnStart refreshed the waiting unit's budget and spent its First-Stand"
    );
    assert_eq!(
        (second.ap, second.first_stand),
        (0, true),
        "a unit whose turn has not started is idle and still First-Standing"
    );

    // The wild unit: rebuilt from its individuality seed, full HP, on spawn_b, with its stance.
    let wilds = w.side_units(id, SideRow::B);
    assert_eq!(wilds.len(), 1);
    let wu = &wilds[0];
    let car = sidecar(wr.species_id);
    let built = game_core::build_monster(
        wr.individuality_seed,
        &species_def(wr.species_id),
        Level::new(wr.level).expect("a band level is a level"),
    );
    assert_eq!(
        (wu.owner, wu.slot, wu.wild_index, wu.monster_id),
        (None, 0, Some(0), None)
    );
    assert_eq!(
        (wu.species_id, wu.level, wu.stats),
        (wr.species_id, wr.level, built.derived_stats)
    );
    assert_eq!(wu.cur_hp, wu.stats.hp, "a fresh wild is at full HP");
    assert_eq!((wu.x, wu.y), (map.spawn_b[0].x, map.spawn_b[0].y));
    assert_eq!(
        (wu.skill_ids.clone(), wu.movement, wu.stance),
        (
            car.kit.to_vec(),
            class_row(car.movement),
            Some(stance_row(car.stance))
        )
    );
    assert_eq!((wu.ap, wu.first_stand), (0, true), "the wild has not acted");
    assert_eq!(
        t.initiative,
        vec![first.unit_id, second.unit_id, wu.unit_id],
        "initiative holds every living unit, fastest first"
    );

    // The side-A clock and its one window row, the transcript, the remembered formation.
    let clock = w.clock(id);
    let open = T0 + i64::from(BATTLE_START_CAP_MS);
    assert_eq!((clock.side, clock.player), (SideRow::A, a()));
    assert_eq!(
        (
            clock.window_seq,
            clock.window_open_ms,
            clock.deadline_ms,
            clock.windows_this_unit_turn
        ),
        (1, Some(open), Some(open + PVE_WINDOW_MS), 1),
        "the window opens after the BattleStarted pad and runs the PvE budget"
    );
    let windows = w.deadlines_of(id);
    assert_eq!(windows.len(), 1, "exactly one window row");
    assert_eq!(
        (
            windows[0].unit_id,
            windows[0].window_seq,
            windows[0].scheduled_at
        ),
        (first.unit_id, 1, time(open + PVE_WINDOW_MS)),
        "armed at exactly the clock's deadline"
    );
    let events = w.events_of(id);
    assert_eq!(
        events.len(),
        1,
        "only BattleStarted precedes the first window"
    );
    assert_eq!((events[0].seq, events[0].round), (0, 1));
    assert!(matches!(
        &events[0].payload,
        EventPayload::BattleStarted(s) if s.round == 1
    ));
    assert_eq!(w.formation_of(a()), Some(vec![11, 12]));
    assert!(
        w.deploys_of(id).is_empty(),
        "no staging row for an auto-deploy"
    );
    assert!(w.queues_of(id).is_empty());
    assert!(w.advances_of(id).is_empty());
    assert!(w.gcs_of(id).is_empty());
}

#[test]
fn forced_pack_of_two_starts_deploying_with_one_deploy_window_row_and_no_units_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let seed = seed_for(4, None);
    let id = start(&fx, a(), seed, Some(2), T0);
    let t = w.tactical(id);
    assert_eq!(
        (t.phase, t.turn_state, t.map_id, t.round),
        (Phase::Deploying, TurnState::NotActive, 4, 1)
    );
    assert!(
        w.units_of(id).is_empty(),
        "no battle_unit row before the deploy"
    );
    assert!(
        w.deploys_of(id).is_empty(),
        "no battle_deploy row before the owner deploys"
    );
    let window = w.only_deadline(id);
    assert_eq!(
        (window.unit_id, window.window_seq, window.scheduled_at),
        (DEPLOY_WINDOW_UNIT, 0, time(T0 + PVE_WINDOW_MS)),
        "the 300 s deploy window rides the (battle, 0, 0) row"
    );
    let clock = w.clock(id);
    assert_eq!(
        (clock.window_seq, clock.window_open_ms, clock.deadline_ms),
        (0, None, None),
        "no turn window has opened"
    );
    let wilds: Vec<(u8, u32)> = w
        .wild_units_of(id)
        .iter()
        .map(|r| (r.wild_index, r.individuality_seed))
        .collect();
    assert_eq!(
        wilds,
        vec![(0, wild_seed(seed, 0)), (1, wild_seed(seed, 1))],
        "one battle_wild_unit per wild, each with its derived individuality seed"
    );
    let secret = w.secret(id);
    assert_eq!(
        (secret.seed, secret.action_seq),
        (splitmix64(seed ^ BATTLE_SEED_SALT), 0)
    );
    assert!(w.events_of(id).is_empty(), "the battle has not started yet");
    let anchor = w.anchor(id).expect("the anchor exists from Deploying on");
    assert_eq!(anchor.state.outcome, BattleOutcome::Ongoing);
    assert!(
        crate::guards::is_in_ongoing_battle(&fx.ctx(), a()),
        "a Deploying battle already holds its player"
    );
}

#[test]
fn deploy_units_materialises_the_picks_and_swaps_the_deploy_window_for_a_turn_window_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(&fx, a(), seed_for(4, None), Some(2), T0);
    deploy(&fx, a(), T0 + 10_000, id, vec![pick(12, 0), pick(11, 1)])
        .expect("a legal pick set deploys");
    let map = map_def(4);
    assert!(
        w.deploys_of(id).is_empty(),
        "the staging row is written and consumed in the deploy transaction"
    );
    let players = w.side_units(id, SideRow::A);
    let placed: Vec<(Option<u64>, u8, u8, u8)> = players
        .iter()
        .map(|u| (u.monster_id, u.slot, u.x, u.y))
        .collect();
    assert_eq!(
        placed,
        vec![
            (Some(12), 0, map.spawn_a[0].x, map.spawn_a[0].y),
            (Some(11), 1, map.spawn_a[1].x, map.spawn_a[1].y),
        ],
        "each pick lands on its slot's spawn tile"
    );
    for u in &players {
        let mid = u.monster_id.expect("a player unit names its monster");
        assert_eq!((u.owner, u.cur_hp), (Some(a()), w.monster(mid).current_hp));
    }
    let wilds: Vec<(Option<u8>, u8, u8, u8)> = w
        .side_units(id, SideRow::B)
        .iter()
        .map(|u| (u.wild_index, u.slot, u.x, u.y))
        .collect();
    assert_eq!(
        wilds,
        vec![
            (Some(0), 0, map.spawn_b[0].x, map.spawn_b[0].y),
            (Some(1), 1, map.spawn_b[1].x, map.spawn_b[1].y),
        ]
    );
    assert_eq!(
        w.formation_of(a()),
        Some(vec![12, 11]),
        "the formation remembers the picks in slot order"
    );
    let t = w.tactical(id);
    let fastest = players
        .iter()
        .find(|u| u.monster_id == Some(11))
        .expect("monster 11 deployed")
        .unit_id;
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Active, TurnState::Waiting(fastest))
    );
    let window = w.only_deadline(id);
    let clock = w.clock(id);
    assert_eq!(
        (window.unit_id, window.window_seq, clock.window_seq),
        (fastest, 1, 1),
        "the deploy window row is gone; exactly one turn window is armed"
    );
    assert_eq!(
        window.scheduled_at,
        time(clock.deadline_ms.expect("an open window has a deadline"))
    );
    assert!(matches!(
        w.events_of(id).first().map(|e| e.payload.clone()),
        Some(EventPayload::BattleStarted(s)) if s.round == 1
    ));
}

/// `start_wild_tactical` refused for `a()` after `setup`, with the store byte-identical.
fn assert_start_refused(
    label: &str,
    pack: Option<u8>,
    want: &str,
    setup: impl FnOnce(&Fixture, &World<'_>),
) {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    setup(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(module(), at(T0), |ctx| {
        super::start_wild_tactical(ctx, a(), seed_for(1, Some(1)), pack)
    });
    assert_eq!(got, Err(want.to_string()), "{label}");
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "{label}: a refused start writes nothing"
    );
}

#[test]
fn start_refuses_bad_packs_busy_or_unfit_parties_and_writes_nothing_bt8_2() {
    assert_start_refused("pack 4", Some(4), "pack must be 1..=3", |_, w| {
        w.seed_party(a(), &TRIO);
    });
    assert_start_refused("pack 0", Some(0), "pack must be 1..=3", |_, w| {
        w.seed_party(a(), &TRIO);
    });
    assert_start_refused(
        "pack beyond the conscious party",
        Some(3),
        "pack 3 exceeds the conscious party (2)",
        |_, w| {
            w.seed_party(a(), &PAIR);
            let mut down = party_monster(a(), (13, 3, 2, 180));
            down.current_hp = 0;
            w.seed_monster(&down);
        },
    );
    assert_start_refused(
        "already in a battle",
        None,
        "already in an ongoing battle",
        |fx, w| {
            w.seed_party(a(), &PAIR);
            start(fx, a(), seed_for(1, Some(1)), None, T0 - 10);
        },
    );
    assert_start_refused(
        "whole party fainted",
        None,
        "party has no conscious monster",
        |_, w| {
            for spec in PAIR {
                let mut m = party_monster(a(), spec);
                m.current_hp = 0;
                w.seed_monster(&m);
            }
        },
    );
    assert_start_refused("no party", None, "no party monster", |_, _| {});
    assert_start_refused(
        "party monster in a trade",
        None,
        "monster is in an active trade",
        |_, w| {
            w.seed_party(a(), &PAIR);
            w.offers.seed(&offer(1, a(), b(), vec![12]));
        },
    );
    assert_start_refused(
        "subject mid-grace",
        None,
        crate::guards::REJECT_DELETION_GATED,
        |_, w| {
            w.seed_party(a(), &PAIR);
            w.accounts.seed(&requested_deletion(
                new_account_row(a(), String::new(), 0),
                T0 - 1_000,
            ));
        },
    );
    assert_start_refused("no character", None, "no character", |_, w| {
        w.seed_party(a(), &PAIR);
        assert_eq!(w.characters.remove(1), 1);
    });
}

#[test]
fn resolve_formation_keeps_remembered_conscious_party_ids_then_fills_from_party_order_bt8_2() {
    let (ma, mb, mc, md) = (101u64, 102, 103, 104);
    let (down, stranger) = (109u64, 777);
    let party = [(ma, true), (mb, true), (mc, true), (down, false)];
    assert_eq!(
        super::resolve_formation(&[ma, down, mb], &party, 3),
        vec![ma, mb, mc],
        "a fainted remembered id is skipped and the gap filled from party order"
    );
    assert_eq!(
        super::resolve_formation(&[stranger, mb], &party, 3),
        vec![mb, ma, mc],
        "a remembered id outside the party (boxed, traded away) is dropped"
    );
    assert_eq!(
        super::resolve_formation(
            &[],
            &[
                (ma, true),
                (down, false),
                (mb, true),
                (mc, true),
                (md, true)
            ],
            3
        ),
        vec![ma, mb, mc],
        "no memory: the first three conscious members in party order"
    );
    assert_eq!(
        super::resolve_formation(&[mb, mb, ma], &party, 3),
        vec![mb, ma, mc],
        "never a duplicate"
    );
    assert_eq!(
        super::resolve_formation(&[mc, mb, ma], &party, 2),
        vec![mc, mb],
        "capped at the spawn count"
    );
    assert_eq!(
        super::resolve_formation(&[ma], &[(ma, false), (down, false)], 3),
        Vec::<u64>::new(),
        "an all-fainted party deploys nobody"
    );
}

#[test]
fn pack_of_one_start_deploys_the_remembered_formation_order_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &QUAD);
    w.formations.seed(&PlayerFormation {
        owner_identity: a(),
        monster_ids: vec![13, 11],
    });
    let id = start(&fx, a(), seed_for(1, Some(1)), None, T0);
    let deployed: Vec<(u8, Option<u64>)> = w
        .side_units(id, SideRow::A)
        .iter()
        .map(|u| (u.slot, u.monster_id))
        .collect();
    assert_eq!(
        deployed,
        vec![(0, Some(13)), (1, Some(11)), (2, Some(12))],
        "remembered order first, then filled from party order, capped at three"
    );
    assert_eq!(
        w.formation_of(a()),
        Some(vec![13, 11, 12]),
        "the formation row is upserted to the deployed order"
    );
    assert_eq!(w.formations.rows().len(), 1, "upserted, never duplicated");
}

#[test]
fn anchor_side_b_battle_monster_carries_the_wild_units_stats_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let anchor = w.anchor(live.id).expect("anchor row");
    let wild = w.unit(live.wild);
    let side_b = &anchor.state.side_b.team;
    assert_eq!(side_b.len(), 1);
    assert_eq!(
        (side_b[0].species_id, side_b[0].level, side_b[0].stats),
        (wild.species_id, wild.level, wild.stats),
        "the anchor's wild is the SAME build as the side-B unit row"
    );
    assert_eq!(
        (side_b[0].current_hp, side_b[0].max_hp),
        (wild.stats.hp, wild.stats.hp)
    );
}

#[test]
fn load_reproduces_the_engine_state_after_start_prequeue_and_live_submit_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);

    // After the start: load is a pure read of the rows, and it reads them faithfully.
    let tb0 = loaded(&fx, live.id, T0);
    assert_eq!(
        tb0,
        loaded(&fx, live.id, T0),
        "two loads with no step between are identical"
    );
    let secret = w.secret(live.id);
    let clock = w.clock(live.id);
    assert_eq!(
        (tb0.battle_id, tb0.turn_state, tb0.state.round),
        (live.id, TurnState::Waiting(live.u1), 1)
    );
    assert_eq!(
        (tb0.state.seed, tb0.state.action_seq),
        (secret.seed, secret.action_seq)
    );
    assert_eq!(
        (
            tb0.clocks[0].window_seq,
            tb0.clocks[0].window_open_ms,
            tb0.clocks[0].deadline_ms
        ),
        (clock.window_seq, clock.window_open_ms, clock.deadline_ms)
    );
    assert_eq!(tb0.state.units.len(), 3);
    assert!(tb0.plans.is_empty());

    // A pre-queue: the stored plan round-trips; nothing else moves.
    let t1 = T0 + 1_000;
    let u2 = w.unit(live.u2);
    let plan = vec![light(&u2, live.wild)];
    let want = engine_step(&tb0, t1, live.u2, plan.clone());
    submit(&fx, a(), t1, live.id, live.u2, plan).expect("pre-queue accepted");
    assert_same_battle(loaded(&fx, live.id, t1), want, "pre-queue");

    // A live submit that leaves AP: budget, clock, roll counter, damage tally and the new
    // window all round-trip through the rows.
    seat_in_light_range(&w, live.u1, live.wild);
    let before = loaded(&fx, live.id, t1);
    let t2 = T0 + 40_000;
    let u1 = w.unit(live.u1);
    let entries = vec![light(&u1, live.wild)];
    let want = engine_step(&before, t2, live.u1, entries.clone());
    assert_ne!(
        want, before,
        "the oracle step changes the battle (non-vacuous)"
    );
    submit(&fx, a(), t2, live.id, live.u1, entries).expect("a live Light is accepted");
    assert_same_battle(loaded(&fx, live.id, t2), want, "live submit");
}

#[test]
fn load_still_hydrates_a_unit_fainted_mid_battle_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(&fx, a(), seed_for(4, None), Some(2), T0);
    deploy(&fx, a(), T0 + 1_000, id, vec![pick(11, 0), pick(12, 1)]).expect("deploy");
    let u1 = w.side_units(id, SideRow::A)[0].unit_id;
    let wilds = w.side_units(id, SideRow::B);
    let (doomed, other) = (wilds[0].unit_id, wilds[1].unit_id);
    assert_eq!(w.tactical(id).turn_state, TurnState::Waiting(u1));
    seat_in_light_range(&w, u1, doomed);
    w.edit_unit(doomed, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    let before = loaded(&fx, id, T0 + 1_000);
    let t = T0 + 20_000;
    let entries = vec![light(&w.unit(u1), doomed)];
    let want = engine_step(&before, t, u1, entries.clone());
    submit(&fx, a(), t, id, u1, entries).expect("the KO submit is accepted");
    let got = loaded(&fx, id, t);
    let ko = got
        .state
        .unit(doomed)
        .expect("a fainted unit is still hydrated (no Fainted rejection)");
    assert_eq!((ko.state, ko.cur_hp), (UnitState::Fainted, 0));
    assert_same_battle(got, want, "KO");
    let row = w.unit(doomed);
    assert_eq!((row.state, row.cur_hp), (UnitState::Fainted, 0));
    assert_eq!(w.unit(other).state, UnitState::Active);
    assert_eq!(w.tactical(id).phase, Phase::Active, "one wild still stands");
}

// ===========================================================================
// BT8.3 — the chain, clock windows, the advance row, stale fires, scheduler-only
// ===========================================================================

#[test]
fn live_submit_with_ap_left_rearms_exactly_one_fresh_window_and_books_idle_time_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_in_light_range(&w, live.u1, live.wild);
    let before = w.clock(live.id);
    let old = w.only_deadline(live.id);
    let opened = before.window_open_ms.expect("the first window is open");
    let t1 = T0 + 60_000;
    let u1 = w.unit(live.u1);
    submit(&fx, a(), t1, live.id, live.u1, vec![light(&u1, live.wild)])
        .expect("a live Light the unit can afford executes");
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.u1),
        "4 AP left: control returns to the same unit"
    );
    let clock = w.clock(live.id);
    assert_eq!((clock.window_seq, clock.windows_this_unit_turn), (2, 2));
    assert_eq!(
        clock.idle_ms_total,
        before.idle_ms_total + u64::try_from(t1 - opened).expect("submitted after the open"),
        "the accepted submit books now - window_open_ms as idle"
    );
    let open = clock.window_open_ms.expect("a fresh window is open");
    let deadline = clock.deadline_ms.expect("the fresh window has a deadline");
    assert_eq!(deadline - open, PVE_WINDOW_MS, "a FRESH full window");
    assert!(
        (0..=5_000).contains(&(open - t1)),
        "the pad is capped at 5 000 ms, got {}",
        open - t1
    );
    let window = w.only_deadline(live.id);
    assert_ne!(
        window.scheduled_id, old.scheduled_id,
        "the closed window's row is disarmed"
    );
    assert_eq!(
        (window.unit_id, window.window_seq, window.scheduled_at),
        (live.u1, 2, time(deadline))
    );
    assert!(w
        .events_of(live.id)
        .iter()
        .any(|e| matches!(&e.payload, EventPayload::Executed(x) if x.attacker == live.u1)));
    let u1_after = w.unit(live.u1);
    assert_eq!((u1_after.ap, u1_after.attacks), (4, 1));
}

#[test]
fn prequeue_and_cancel_for_another_unit_leave_the_waiting_units_window_untouched_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let window = row_set(&w.deadlines_of(live.id));
    let clock = enc(&w.clock(live.id));
    submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("pre-queue for the other unit");
    assert_eq!(
        row_set(&w.deadlines_of(live.id)),
        window,
        "U's deadline row untouched"
    );
    assert_eq!(enc(&w.clock(live.id)), clock, "U's clock untouched");
    cancel(&fx, a(), T0 + 2_000, live.id, live.u2).expect("cancel the READY row");
    assert!(w.queues_of(live.id).is_empty(), "the READY row is deleted");
    assert_eq!(
        row_set(&w.deadlines_of(live.id)),
        window,
        "U's deadline row untouched"
    );
    assert_eq!(enc(&w.clock(live.id)), clock, "U's clock untouched");
}

#[test]
fn completed_round_arms_one_advance_row_and_its_fire_runs_the_next_round_once_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &TRIO);
    let id = start(&fx, a(), seed_for(1, Some(1)), None, T0);
    let p: Vec<u32> = w
        .side_units(id, SideRow::A)
        .iter()
        .map(|u| u.unit_id)
        .collect();
    assert_eq!(p.len(), 3);
    assert_eq!(w.tactical(id).turn_state, TurnState::Waiting(p[0]));
    for &unit in &p[1..] {
        submit(&fx, a(), T0 + 1_000, id, unit, vec![QueuedAction::EndTurn])
            .expect("pre-queue the units after the waiting one");
    }
    assert!(w.advances_of(id).is_empty(), "no round boundary yet");

    let t2 = T0 + 2_000;
    submit(&fx, a(), t2, id, p[0], vec![QueuedAction::EndTurn])
        .expect("the waiting unit ends its turn live");
    let t = w.tactical(id);
    assert_eq!(
        (t.turn_state, t.round),
        (TurnState::Advancing, 2),
        "the round completed without input: Advancing to round 2"
    );
    let adv = w.advances_of(id);
    assert_eq!(adv.len(), 1, "exactly one advance row");
    assert_eq!(
        (adv[0].round, adv[0].scheduled_at),
        (2, time(t2)),
        "pinned to the round about to start, zero delay"
    );
    assert!(
        w.deadlines_of(id).is_empty(),
        "no window is open at a round boundary"
    );
    let round_end = w
        .events_of(id)
        .into_iter()
        .find(|e| matches!(&e.payload, EventPayload::RoundEnded(r) if r.round == 1))
        .expect("round 1's upkeep ran");

    // Pre-queue + cancel + pre-queue while Advancing arm no second boundary row.
    let t3 = T0 + 3_000;
    submit(&fx, a(), t3, id, p[1], vec![QueuedAction::EndTurn]).expect("pre-queue");
    cancel(&fx, a(), t3, id, p[1]).expect("cancel");
    submit(&fx, a(), t3, id, p[0], vec![QueuedAction::EndTurn]).expect("pre-queue for round 2");
    let still: Vec<u64> = w.advances_of(id).iter().map(|r| r.scheduled_id).collect();
    assert_eq!(
        still,
        vec![adv[0].scheduled_id],
        "still exactly the one advance row"
    );
    assert_eq!(w.tactical(id).turn_state, TurnState::Advancing);

    // The module fires the boundary: round 2 runs from its first unit.
    fire_advance(&fx, T0 + 4_000, advance_args(&adv[0])).expect("the boundary fire is Ok");
    let t = w.tactical(id);
    assert_eq!(
        (t.round, t.turn_state),
        (2, TurnState::Waiting(p[1])),
        "p0's READY row executes, then p1 waits"
    );
    let round2: Vec<BattleEvent> = w
        .events_of(id)
        .into_iter()
        .filter(|e| e.round == 2)
        .collect();
    assert!(
        round2
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::TurnEnded(x) if x.unit == p[0])),
        "round 2 started and p0 took its turn"
    );
    assert!(
        round2.iter().all(|e| e.seq > round_end.seq),
        "RoundEnded{{1}} precedes every event of round 2"
    );
    let clock = w.clock(id);
    let window = w.only_deadline(id);
    assert_eq!(
        (window.unit_id, window.window_seq, clock.window_seq),
        (p[1], 2, 2)
    );

    // A duplicate fire of the same pin is a no-op.
    let before = w.snapshot();
    fire_advance(&fx, T0 + 5_000, advance_args(&adv[0])).expect("a stale boundary fire is Ok");
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn stale_and_premature_deadline_fires_change_nothing_but_a_rearm_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let real = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    assert_eq!(real.scheduled_at, time(deadline));
    let before = w.snapshot();
    for (label, unit_id, window_seq) in [
        ("previous window_seq", live.u1, 0),
        ("not the waiting unit", live.u2, 1),
        ("deploy sentinel on an Active battle", DEPLOY_WINDOW_UNIT, 0),
    ] {
        let args = TacticalDeadlineSched {
            scheduled_id: 9_100,
            scheduled_at: time(deadline),
            battle_id: live.id,
            unit_id,
            window_seq,
        };
        assert_eq!(fire_deadline(&fx, deadline, args), Ok(()), "{label}");
        assert_eq!(
            changed(&before, &w.snapshot()),
            none(),
            "{label}: a stale fire is a no-op"
        );
    }

    assert_eq!(
        fire_deadline(&fx, deadline - 1, deadline_args(&real)),
        Ok(()),
        "a premature fire is Ok"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        vec!["tactical_deadline_sched"],
        "a premature fire only re-arms"
    );
    assert_eq!(w.tactical(live.id).turn_state, TurnState::Waiting(live.u1));
    let rearmed: Vec<(u32, u32, ScheduleAt)> = w
        .deadlines_of(live.id)
        .iter()
        .filter(|r| r.scheduled_id != real.scheduled_id)
        .map(|r| (r.unit_id, r.window_seq, r.scheduled_at))
        .collect();
    assert_eq!(
        rearmed,
        vec![(live.u1, 1, time(deadline))],
        "one new row, same pin, at the same deadline"
    );
}

#[test]
fn deadline_fire_at_the_deadline_auto_flees_persists_hp_and_voids_ready_rows_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    submit(
        &fx,
        a(),
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("u2 holds a READY row");
    w.edit_unit(live.u1, |u| u.cur_hp = 175);
    let real = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    w.deadlines.seed(&TacticalDeadlineSched {
        scheduled_id: 9_001,
        scheduled_at: time(deadline + 50),
        battle_id: live.id,
        unit_id: live.u2,
        window_seq: 0,
    });

    assert_eq!(fire_deadline(&fx, deadline, deadline_args(&real)), Ok(()));
    let anchor = w.anchor(live.id).expect("the anchor survives, terminal");
    assert_eq!(
        anchor.state.outcome,
        BattleOutcome::Fled,
        "wild expiry is AutoFlee"
    );
    let t = w.tactical(live.id);
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert_eq!(
        (w.monster(11).current_hp, w.monster_pub(11).current_hp),
        (175, 175),
        "the damaged HP is persisted and the projection re-synced"
    );
    assert_eq!(w.monster(12).current_hp, 300);
    assert!(w.queues_of(live.id).is_empty(), "the READY row is voided");
    let events = w.events_of(live.id);
    assert!(events
        .iter()
        .any(|e| matches!(&e.payload, EventPayload::QueueVoided(v) if v.unit == live.u2)));
    assert!(
        !events
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::Executed(x) if x.attacker == live.u2)),
        "a voided READY row never executes"
    );
    assert!(events.iter().any(|e| matches!(
        &e.payload,
        EventPayload::BattleEnd(x) if x.outcome == BattleOutcome::Fled && x.how == EndHow::AutoFlee
    )));
    let leftover: Vec<u64> = w
        .deadlines_of(live.id)
        .iter()
        .map(|r| r.scheduled_id)
        .filter(|&sid| sid != real.scheduled_id)
        .collect();
    assert!(
        leftover.is_empty(),
        "every other deadline row of the battle is swept: {leftover:?}"
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(
        gcs,
        vec![time(deadline + GC_DELAY_MS)],
        "exactly one GC row"
    );
}

#[test]
fn submit_after_the_deadline_beats_a_late_fire_and_a_fire_beats_a_late_submit_bt8_3() {
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        let real = w.only_deadline(live.id);
        let deadline = w.clock(live.id).deadline_ms.expect("an open window");
        submit(
            &fx,
            a(),
            deadline + 1,
            live.id,
            live.u1,
            vec![QueuedAction::EndTurn],
        )
        .expect("a submit after the deadline but before the fire is accepted");
        assert_eq!(
            w.tactical(live.id).turn_state,
            TurnState::Waiting(live.u2),
            "the chain moved on to the next unit"
        );
        let before = w.snapshot();
        assert_eq!(
            fire_deadline(&fx, deadline + 2, deadline_args(&real)),
            Ok(())
        );
        assert_eq!(
            changed(&before, &w.snapshot()),
            none(),
            "the late fire finds its window closed: a no-op"
        );
    }
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        let real = w.only_deadline(live.id);
        let deadline = w.clock(live.id).deadline_ms.expect("an open window");
        assert_eq!(fire_deadline(&fx, deadline, deadline_args(&real)), Ok(()));
        assert_eq!(
            w.anchor(live.id).expect("anchor").state.outcome,
            BattleOutcome::Fled
        );
        let before = w.snapshot();
        assert_eq!(
            submit(
                &fx,
                a(),
                deadline + 1,
                live.id,
                live.u1,
                vec![QueuedAction::EndTurn]
            ),
            Err("battle is not ongoing".to_string())
        );
        assert_eq!(changed(&before, &w.snapshot()), none());
    }
}

#[test]
fn scheduled_reducers_refuse_every_sender_but_the_module_and_write_nothing_bt8_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let real = w.only_deadline(live.id);
    let due = T0 + 2 * PVE_WINDOW_MS;
    let before = w.snapshot();
    for who in [a(), b()] {
        assert_eq!(
            fx.run_as_at(who, at(due), |ctx| {
                super::tactical_deadline_fire(ctx, deadline_args(&real))
            }),
            Err("tactical_deadline_fire is scheduler-only".to_string())
        );
        let adv = TacticalAdvanceSched {
            scheduled_id: 9_201,
            scheduled_at: time(T0),
            battle_id: live.id,
            round: 1,
        };
        assert_eq!(
            fx.run_as_at(who, at(due), |ctx| super::tactical_advance(ctx, adv)),
            Err("tactical_advance is scheduler-only".to_string())
        );
        let gc = BattleGcSched {
            scheduled_id: 9_301,
            scheduled_at: time(T0),
            battle_id: live.id,
        };
        assert_eq!(
            fx.run_as_at(who, at(due), |ctx| super::battle_gc(ctx, gc)),
            Err("battle_gc is scheduler-only".to_string())
        );
    }
    assert_eq!(changed(&before, &w.snapshot()), none());
}

// ===========================================================================
// BT8.4 — a Deploying battle already holds the interlock; its expiry releases it
// ===========================================================================

#[test]
fn propose_trade_refuses_a_party_monster_of_a_deploying_tactical_battle_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    w.join(b(), 2);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| {
        crate::trading::propose_trade(ctx, b(), vec![11], Vec::new(), 0, Vec::new(), Vec::new(), 0)
    });
    assert_eq!(got, Err("monster is in an ongoing battle".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn care_refuses_while_a_deploying_tactical_battle_holds_the_player_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| crate::raising::care(ctx, 11));
    assert_eq!(got, Err("cannot care during an ongoing battle".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn train_refuses_while_a_deploying_tactical_battle_holds_the_player_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| {
        crate::raising::train(ctx, 11, 77)
    });
    assert_eq!(
        got,
        Err("cannot train during an ongoing battle".to_string())
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn enqueue_move_refuses_while_a_deploying_tactical_battle_holds_the_player_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| {
        crate::movement::enqueue_move(ctx, MoveInput::Step(Direction::North), 1)
    });
    assert_eq!(got, Err("cannot move during an ongoing battle".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn set_move_refuses_while_a_deploying_tactical_battle_holds_the_player_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| {
        crate::movement::set_move(ctx, MoveInput::Step(Direction::North), 1)
    });
    assert_eq!(got, Err("cannot move during an ongoing battle".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn evolve_refuses_a_party_monster_of_a_deploying_tactical_battle_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    deploying_pair(&fx, &w);
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 1_000), |ctx| {
        crate::evolution::evolve(ctx, 11, 4)
    });
    assert_eq!(got, Err("monster is in an ongoing battle".to_string()));
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn deploy_window_expiry_closes_as_fled_without_hp_and_releases_the_interlock_bt8_4() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pair(&fx, &w);
    let party = (row_set(&w.monsters.rows()), row_set(&w.pubs.rows()));
    let window = w.only_deadline(id);
    let expiry = T0 + PVE_WINDOW_MS;

    // A unit-window pin while Deploying is stale.
    let before = w.snapshot();
    let stale = TacticalDeadlineSched {
        scheduled_id: 9_150,
        scheduled_at: time(expiry),
        battle_id: id,
        unit_id: 5,
        window_seq: 1,
    };
    assert_eq!(fire_deadline(&fx, expiry, stale), Ok(()));
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "a non-sentinel fire on a Deploying battle is a no-op"
    );

    assert_eq!(fire_deadline(&fx, expiry, deadline_args(&window)), Ok(()));
    let anchor = w.anchor(id).expect("the anchor survives, terminal");
    assert_eq!(anchor.state.outcome, BattleOutcome::Fled);
    let t = w.tactical(id);
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert!(
        !crate::guards::is_in_ongoing_battle(&fx.ctx(), a()),
        "the expiry releases the interlock"
    );
    assert_eq!(
        (row_set(&w.monsters.rows()), row_set(&w.pubs.rows())),
        party,
        "a Deploying close writes no HP"
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(expiry + GC_DELAY_MS)]);
    let got = fx.run_as_at(a(), at(expiry + 1), |ctx| {
        crate::evolution::evolve(ctx, 11, 999)
    });
    assert_eq!(
        got,
        Err("no such evolution: species 1 has no path to species 999".to_string()),
        "the same caller now passes the battle guard and reaches its own next check"
    );
}

// ===========================================================================
// BT8.5 — disconnect: auto-flee Active, close Deploying, last session only, never panic
// ===========================================================================

#[test]
fn disconnect_resolve_auto_flees_an_active_wild_persists_damage_and_voids_ready_rows_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &QUAD);
    let id = start(&fx, a(), seed_for(1, Some(1)), None, T0);
    let players = w.side_units(id, SideRow::A);
    let deployed: Vec<u64> = players.iter().filter_map(|u| u.monster_id).collect();
    assert_eq!(deployed, vec![11, 12, 13], "monster 14 stays on the bench");
    let (u1, u2) = (players[0].unit_id, players[1].unit_id);
    submit(&fx, a(), T0 + 1_000, id, u2, vec![QueuedAction::EndTurn]).expect("READY row");
    w.edit_unit(u1, |u| u.cur_hp = 150);
    w.edit_unit(u2, |u| u.cur_hp = 120);
    let bench = (enc(&w.monster(14)), enc(&w.monster_pub(14)));
    let t2 = T0 + 9_000;

    crate::resolve_all_live_interactions(&fx.ctx_at(at(t2)), a());

    let anchor = w
        .anchor(id)
        .expect("the anchor SURVIVES the legacy resolver that follows (terminal)");
    assert_eq!(anchor.state.outcome, BattleOutcome::Fled);
    let t = w.tactical(id);
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    for (mid, hp) in [(11u64, 150u16), (12, 120), (13, 300)] {
        assert_eq!(
            (w.monster(mid).current_hp, w.monster_pub(mid).current_hp),
            (hp, hp),
            "monster {mid}: the deployed unit's HP is persisted"
        );
    }
    assert_eq!(
        (enc(&w.monster(14)), enc(&w.monster_pub(14))),
        bench,
        "a non-deployed party member is untouched"
    );
    assert!(w.queues_of(id).is_empty(), "READY rows discarded");
    assert!(w.deadlines_of(id).is_empty(), "the open window is disarmed");
    assert!(w.advances_of(id).is_empty());
    let gcs: Vec<ScheduleAt> = w.gcs_of(id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t2 + GC_DELAY_MS)], "exactly one GC row");
    let events = w.events_of(id);
    let end = events
        .iter()
        .find(|e| {
            matches!(
                &e.payload,
                EventPayload::BattleEnd(x) if x.outcome == BattleOutcome::Fled && x.how == EndHow::AutoFlee
            )
        })
        .expect("BattleEnd{Fled, AutoFlee}");
    assert!(events
        .iter()
        .any(|e| matches!(&e.payload, EventPayload::QueueVoided(v) if v.unit == u2)));
    assert!(
        !events
            .iter()
            .any(|e| e.seq > end.seq && matches!(&e.payload, EventPayload::Executed(_))),
        "nothing executes after the battle ends"
    );
    assert!(!events
        .iter()
        .any(|e| matches!(&e.payload, EventPayload::Executed(x) if x.attacker == u2)));

    let after = w.snapshot();
    crate::resolve_all_live_interactions(&fx.ctx_at(at(t2 + 1_000)), a());
    assert_eq!(
        changed(&after, &w.snapshot()),
        none(),
        "a second resolve is a no-op"
    );
}

#[test]
fn disconnect_resolve_closes_a_deploying_battle_as_fled_and_persists_nothing_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pair(&fx, &w);
    let party = (row_set(&w.monsters.rows()), row_set(&w.pubs.rows()));
    let t1 = T0 + 60_000;
    crate::resolve_all_live_interactions(&fx.ctx_at(at(t1)), a());
    let anchor = w.anchor(id).expect("the anchor survives, terminal");
    assert_eq!(anchor.state.outcome, BattleOutcome::Fled);
    assert_eq!(w.tactical(id).phase, Phase::Finished);
    assert_eq!(
        (row_set(&w.monsters.rows()), row_set(&w.pubs.rows())),
        party,
        "a Deploying close persists nothing"
    );
    assert!(
        w.deadlines_of(id).is_empty(),
        "the (battle, 0, 0) deploy-window row is disarmed"
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t1 + GC_DELAY_MS)]);
    assert!(!crate::guards::is_in_ongoing_battle(&fx.ctx(), a()));
    let after = w.snapshot();
    crate::resolve_all_live_interactions(&fx.ctx_at(at(t1 + 1_000)), a());
    assert_eq!(
        changed(&after, &w.snapshot()),
        none(),
        "a second resolve is a no-op"
    );
}

#[test]
fn on_disconnect_waits_for_the_last_session_then_resolves_the_tactical_battle_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.edit_unit(live.u1, |u| u.cur_hp = 140);
    for conn in [CONN_A, CONN_A2] {
        w.sessions.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(conn),
            identity: a(),
        });
    }
    let before = w.snapshot();
    fx.run_as_conn_at(a(), CONN_A, None, at(T0 + 5_000), crate::on_disconnect);
    assert_eq!(
        changed(&before, &w.snapshot()),
        vec!["player_session"],
        "with a second live session only the leaving connection's row goes"
    );
    let left: Vec<u128> = w
        .sessions
        .rows()
        .iter()
        .map(|s| s.connection_id.to_u128())
        .collect();
    assert_eq!(left, vec![CONN_A2]);

    assert_eq!(w.sessions.remove(a()), 1);
    let t2 = T0 + 6_000;
    fx.run_as_conn_at(a(), CONN_A, None, at(t2), crate::on_disconnect);
    let anchor = w.anchor(live.id).expect("the anchor survives, terminal");
    assert_eq!(anchor.state.outcome, BattleOutcome::Fled);
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    assert_eq!(w.monster(11).current_hp, 140, "the damaged HP is persisted");
    let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t2 + GC_DELAY_MS)]);
    assert!(
        w.players.rows().iter().all(|p| p.identity != a()),
        "the last disconnect still clears the presence rows"
    );
}

#[test]
fn unloadable_battle_falls_back_to_a_fled_close_with_unit_hp_persisted_bt8_5() {
    for label in ["content version drift", "unknown map"] {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        submit(
            &fx,
            a(),
            T0 + 1_000,
            live.id,
            live.u2,
            vec![QueuedAction::EndTurn],
        )
        .expect("READY row");
        w.edit_unit(live.u1, |u| u.cur_hp = 160);
        w.edit_tactical(live.id, |t| {
            if label == "unknown map" {
                t.map_id = 999;
            } else {
                t.content_version = crate::CONTENT_VERSION + 1;
            }
        });
        let t2 = T0 + 7_000;
        super::resolve_tactical_on_disconnect(&fx.ctx_at(at(t2)), a());
        let anchor = w
            .anchor(live.id)
            .unwrap_or_else(|| panic!("{label}: the anchor is updated, never deleted"));
        assert_eq!(anchor.state.outcome, BattleOutcome::Fled, "{label}");
        assert_eq!(w.tactical(live.id).phase, Phase::Finished, "{label}");
        assert_eq!(
            (w.monster(11).current_hp, w.monster(12).current_hp),
            (160, 300),
            "{label}: each side-A unit's HP is written straight to its monster"
        );
        assert!(w.queues_of(live.id).is_empty(), "{label}");
        assert!(w.deadlines_of(live.id).is_empty(), "{label}");
        let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
        assert_eq!(gcs, vec![time(t2 + GC_DELAY_MS)], "{label}");
    }
}

/// What every legacy 1v1 reducer returns on a tactical anchor (`reject_if_tactical_anchor`).
const TACTICAL_REFUSAL: &str = "tactical battle: use the tactical reducers";

/// Retargeted by bt-9 (the plan's RT-1, under BT9.1 "paid once"; was
/// `legacy_flee_on_a_tactical_anchor_persists_the_mirrored_tactical_hp_bt8_5`): a 1v1 reducer
/// may not act on a tactical anchor at all — a legacy turn would run the 1v1 funnel's own payout
/// beside the ledger's. Each one refuses with the guard's own error before any write: no monster,
/// wallet, anchor or tactical row moves. Every call would SUCCEED without the guard — the lead
/// carries the Poison item 3 cures (so `use_battle_item` is not stopped by its own "no matching
/// status" check), monster 12 is a conscious swap target, the skill is in the lead's moveset — so
/// each exact-error assertion bites on its own reducer's guard.
#[test]
fn legacy_one_v_one_reducers_refuse_a_tactical_anchor_and_write_nothing_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.inventory.seed(&Inventory {
        inv_id: 501,
        owner_identity: a(),
        item_id: 3,
        count: 2,
    });
    assert!(
        game_core::load_items()
            .expect("item content loads")
            .iter()
            .find(|i| i.id == 3)
            .and_then(|i| i.cure_status)
            .is_some_and(|cure| cure.matches(&game_core::StatusEffect::Poison)),
        "PRECONDITION: item 3 cures Poison"
    );
    let mut anchor = w.anchor(live.id).expect("anchor");
    assert_eq!(
        anchor.state.side_a.active, 0,
        "PRECONDITION: the anchor's lead is team[0]"
    );
    anchor.state.side_a.team[0].status = Some(game_core::StatusEffect::Poison);
    assert_eq!(w.battles.remove(live.id), 1, "the anchor edited in place");
    w.battles.seed(&anchor);
    let skill = anchor.state.side_a.team[0]
        .known_skill_ids
        .first()
        .copied()
        .expect("the lead knows a skill");
    let refused: Result<(), String> = Err(TACTICAL_REFUSAL.to_string());
    let before = w.snapshot();
    let t = T0 + 40_000;
    let flee = fx.run_as_at(a(), at(t), |ctx| crate::battle::flee(ctx, live.id));
    assert_eq!(flee, refused, "flee on a tactical anchor is refused");
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "flee writes nothing"
    );
    let item = fx.run_as_at(a(), at(t), |ctx| {
        crate::battle::use_battle_item(ctx, live.id, 3)
    });
    assert_eq!(
        item, refused,
        "use_battle_item is refused although the lead's Poison is curable"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "use_battle_item writes nothing (no debit, no cure)"
    );
    let swap = fx.run_as_at(a(), at(t), |ctx| {
        crate::battle::swap_active(ctx, live.id, 1)
    });
    assert_eq!(swap, refused, "swap_active is refused");
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "swap_active writes nothing"
    );
    let attack = fx.run_as_at(a(), at(t), |ctx| {
        crate::battle::submit_attack(ctx, live.id, skill)
    });
    assert_eq!(attack, refused, "submit_attack is refused");
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "submit_attack writes nothing"
    );
    assert_eq!(
        w.anchor(live.id).expect("anchor").state.outcome,
        BattleOutcome::Ongoing,
        "the tactical battle is still the tactical reducers' to finish"
    );
}

/// RT-1 covers the fifth legacy reducer: `taming::attempt_recruit` on a tactical anchor is refused
/// with the guard's error and writes nothing, EVEN when a `battle_wild` row exists for the anchor
/// (its own "not a wild battle" refusal is then no protection). The fixture makes the unguarded
/// path go all the way: a sure-hit bait row (bonus 1000 — `recruit_chance` clamps, so any
/// `ctx.random()` draw recruits), a held stack of 2, and the content species rows its success arm
/// reads. Without the guard the bait is debited, a playtest row written and the wild recruited.
#[test]
fn legacy_attempt_recruit_refuses_a_tactical_anchor_even_with_a_battle_wild_row_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let items = fx.table_keyed::<crate::schema::ItemRow, u32>("item_row", "id", |r| r.id);
    items.seed(&crate::schema::ItemRow {
        id: 1,
        name: "bait".to_string(),
        description: String::new(),
        recruit_bonus: 1_000,
        train_stat: None,
        train_amount: 0,
        sell_price: 0,
        cure_status: None,
    });
    let species_rows =
        fx.table_keyed::<crate::schema::SpeciesRow, u32>("species_row", "id", |r| r.id);
    for s in &game_core::load_species().expect("species content loads") {
        species_rows.seed(&crate::schema::SpeciesRow {
            id: s.id,
            name: s.name.clone(),
            base_hp: s.base_stats.hp,
            base_attack: s.base_stats.attack,
            base_defense: s.base_stats.defense,
            base_speed: s.base_stats.speed,
            base_sp_attack: s.base_stats.sp_attack,
            base_sp_defense: s.base_stats.sp_defense,
            affinity: s.affinity,
            learnable_skill_ids: s.learnable_skill_ids.clone(),
            ability: s.ability,
            tier: s.tier,
        });
    }
    w.inventory.seed(&Inventory {
        inv_id: 501,
        owner_identity: a(),
        item_id: 1,
        count: 2,
    });
    assert!(
        w.battle_wilds.rows().is_empty(),
        "PRECONDITION: a tactical start writes no battle_wild row of its own"
    );
    let wild = w.wild_units_of(live.id)[0].clone();
    w.battle_wilds.seed(&BattleWild {
        battle_id: live.id,
        wild_species_id: wild.species_id,
        wild_level: wild.level,
        individuality_seed: wild.individuality_seed,
    });
    let before = w.snapshot();
    let got = fx.run_as_at(a(), at(T0 + 40_000), |ctx| {
        crate::taming::attempt_recruit(ctx, live.id, Some(1))
    });
    assert_eq!(
        got,
        Err(TACTICAL_REFUSAL.to_string()),
        "attempt_recruit on a tactical anchor is refused by the guard"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "no bait debited, no playtest row, no recruit, no anchor change"
    );
    assert_eq!(
        w.anchor(live.id).expect("anchor").state.outcome,
        BattleOutcome::Ongoing,
        "the tactical battle is still the tactical reducers' to finish"
    );
}

/// BT9.1 "paid once": `finish` re-reads the STORED tactical row, so a caller holding a stale
/// Active copy (and the final board) cannot settle a battle a second time. The first finish
/// must have paid (the red at the freeze), the second must change nothing.
#[test]
fn a_stale_active_copy_finished_again_after_the_settlement_pays_nothing_more_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_in_light_range(&w, live.u1, live.wild);
    w.edit_unit(live.wild, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    let stale = w.tactical(live.id);
    assert_eq!(
        stale.phase,
        Phase::Active,
        "PRECONDITION: the copy is Active"
    );
    // The same step as `battle_won_inside_a_live_submit_..._bt8_6` (its roll lands).
    let t1 = T0 + 25_000;
    let u1 = w.unit(live.u1);
    submit(&fx, a(), t1, live.id, live.u1, vec![light(&u1, live.wild)])
        .expect("the KO submit is accepted");
    assert_eq!(
        w.anchor(live.id).expect("anchor").state.outcome,
        BattleOutcome::SideAWins,
        "PRECONDITION: the KO won the battle"
    );
    let paid: u64 = w.wallets.rows().iter().map(|r| r.balance).sum();
    assert!(
        paid > 0,
        "the real finish paid the ledger's currency, got {paid}"
    );
    let state = loaded(&fx, live.id, t1).state;
    let anchor = w.anchor(live.id).expect("anchor");
    let before = w.snapshot();
    fx.run_as_at(module(), at(t1 + 1), |ctx| {
        super::finish(
            ctx,
            Some(anchor),
            stale,
            crate::tactics_settle::Close::Settled { state: &state },
            t1 + 1,
            super::Except::None,
        );
    });
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "a second finish pays, penalises, sweeps and summarises nothing"
    );
}

// ===========================================================================
// BT8.6 — finish writes the outcome and HP once; the 24 h GC sweeps the transcript
// ===========================================================================

#[test]
fn battle_won_inside_a_live_submit_writes_side_a_wins_persists_hp_and_arms_one_gc_bt8_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_in_light_range(&w, live.u1, live.wild);
    w.edit_unit(live.wild, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    w.edit_unit(live.u1, |u| u.cur_hp = 222);
    let t1 = T0 + 25_000;
    let u1 = w.unit(live.u1);
    submit(&fx, a(), t1, live.id, live.u1, vec![light(&u1, live.wild)])
        .expect("the KO submit is accepted");
    let anchor = w.anchor(live.id).expect("anchor");
    assert_eq!(anchor.state.outcome, BattleOutcome::SideAWins);
    let t = w.tactical(live.id);
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert_eq!(
        (w.monster(11).current_hp, w.monster_pub(11).current_hp),
        (222, 222)
    );
    assert_eq!(w.monster(12).current_hp, 300);
    assert!(w.queues_of(live.id).is_empty());
    assert!(
        w.deadlines_of(live.id).is_empty(),
        "no window outlives the finish"
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t1 + DAY_MS)], "exactly one GC row, 24 h out");
    let events = w.events_of(live.id);
    assert!(events
        .iter()
        .any(|e| matches!(&e.payload, EventPayload::Ko(k) if k.unit == live.wild)));
    assert!(events.iter().any(|e| matches!(
        &e.payload,
        EventPayload::BattleEnd(x) if x.outcome == BattleOutcome::SideAWins
    )));
}

#[test]
fn voluntary_flee_entry_ends_the_battle_fled_persists_hp_and_arms_gc_bt8_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.edit_unit(live.u1, |u| u.cur_hp = 210);
    let t1 = T0 + 25_000;
    submit(&fx, a(), t1, live.id, live.u1, vec![QueuedAction::Flee])
        .expect("a full-AP unit may flee");
    assert_eq!(
        w.anchor(live.id).expect("anchor").state.outcome,
        BattleOutcome::Fled
    );
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    assert_eq!(
        (w.monster(11).current_hp, w.monster_pub(11).current_hp),
        (210, 210)
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t1 + DAY_MS)]);
    assert!(w.events_of(live.id).iter().any(|e| matches!(
        &e.payload,
        EventPayload::BattleEnd(x) if x.outcome == BattleOutcome::Fled && x.how == EndHow::Fled
    )));
}

/// A battle A fled at `T0 + 30_000` (whose finish wrote its own summary row — bt-9, BT9.5), plus
/// stray per-battle rows the GC must also take, and a bystander battle's event. Returns
/// `(battle_id, the GC row, flee time)`.
fn fled_battle_with_strays(fx: &Fixture, w: &World<'_>) -> (u64, BattleGcSched, i64) {
    let live = live_pair(fx, w);
    let t1 = T0 + 30_000;
    submit(fx, a(), t1, live.id, live.u1, vec![QueuedAction::Flee]).expect("flee");
    let mut gcs = w.gcs_of(live.id);
    assert_eq!(gcs.len(), 1, "the finish armed one GC row");
    let gc = gcs.remove(0);
    assert!(
        w.summaries
            .rows()
            .iter()
            .any(|s| s.battle_id == live.id && s.outcome == BattleOutcome::Fled),
        "non-vacuous: the finish wrote the battle's real summary row (finalised Fled)"
    );
    w.queues.seed(&BattleQueue {
        unit_id: 9_999,
        battle_id: live.id,
        owner: a(),
        entries: vec![QueuedAction::EndTurn],
        submitted_at_ms: t1,
    });
    w.deploys.seed(&BattleDeploy {
        deploy_id: 9_998,
        battle_id: live.id,
        owner: a(),
        side: SideRow::A,
        picks: Vec::new(),
        locked: false,
    });
    w.deadlines.seed(&TacticalDeadlineSched {
        scheduled_id: 9_997,
        scheduled_at: time(t1),
        battle_id: live.id,
        unit_id: live.u1,
        window_seq: 9,
    });
    w.advances.seed(&TacticalAdvanceSched {
        scheduled_id: 9_996,
        scheduled_at: time(t1),
        battle_id: live.id,
        round: 9,
    });
    w.events.seed(&BattleEvent {
        event_id: 9_995,
        battle_id: 4_242,
        seq: 0,
        round: 1,
        payload: EventPayload::RoundEnded(game_core::tactics::RoundEndedEvent { round: 1 }),
    });
    for table in [
        "battle_event",
        "battle_unit",
        "battle_queue",
        "battle_clock",
        "battle_secret",
        "battle_wild_unit",
        "battle_deploy",
    ] {
        assert!(
            w.per_battle(live.id)
                .iter()
                .any(|&(name, n)| name == table && n > 0),
            "non-vacuous: {table} holds rows before the sweep"
        );
    }
    (live.id, gc, t1)
}

#[test]
fn battle_gc_at_its_time_sweeps_the_transcript_and_keeps_the_anchor_tactical_and_summary_bt8_6() {
    let fx = fixture();
    let w = world(&fx);
    let (id, gc, t1) = fled_battle_with_strays(&fx, &w);
    assert_eq!(gc.scheduled_at, time(t1 + DAY_MS));
    assert_eq!(fire_gc(&fx, t1 + DAY_MS, gc_args(&gc)), Ok(()));
    let left: Vec<(&str, usize)> = w
        .per_battle(id)
        .into_iter()
        .filter(|&(_, n)| n > 0)
        .collect();
    assert!(
        left.is_empty(),
        "event, unit, queue, clock, secret, wild-unit, deploy and schedule rows are swept: {left:?}"
    );
    assert!(w.anchor(id).is_some(), "the anchor survives the GC");
    assert!(
        w.try_tactical(id).is_some(),
        "battle_tactical survives the GC"
    );
    assert!(
        w.summaries.rows().iter().any(|s| s.battle_id == id),
        "battle_summary survives the GC"
    );
    assert!(
        w.events.rows().iter().any(|e| e.battle_id == 4_242),
        "another battle's transcript is untouched"
    );
}

#[test]
fn battle_gc_also_drops_the_tactical_row_once_the_anchor_is_gone_bt8_6() {
    let fx = fixture();
    let w = world(&fx);
    let (id, gc, t1) = fled_battle_with_strays(&fx, &w);
    assert_eq!(
        w.battles.remove(id),
        1,
        "a prior-terminal sweep deleted the anchor"
    );
    assert_eq!(fire_gc(&fx, t1 + DAY_MS, gc_args(&gc)), Ok(()));
    let left: Vec<(&str, usize)> = w
        .per_battle(id)
        .into_iter()
        .filter(|&(_, n)| n > 0)
        .collect();
    assert!(left.is_empty(), "per-battle rows swept: {left:?}");
    assert!(
        w.try_tactical(id).is_none(),
        "an anchor-less battle_tactical row goes with the sweep"
    );
    assert!(
        w.summaries.rows().iter().any(|s| s.battle_id == id),
        "battle_summary survives the GC"
    );
}

#[test]
fn battle_gc_leaves_an_active_battle_alone_and_rearms_a_premature_fire_bt8_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let before = w.snapshot();
    let early = BattleGcSched {
        scheduled_id: 9_401,
        scheduled_at: time(T0 + 10_000),
        battle_id: live.id,
    };
    assert_eq!(fire_gc(&fx, T0 + 10_000, early), Ok(()));
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "an Active battle is never swept"
    );

    let t1 = T0 + 30_000;
    submit(&fx, a(), t1, live.id, live.u1, vec![QueuedAction::Flee]).expect("flee");
    let gc = w.gcs_of(live.id).remove(0);
    let due = t1 + DAY_MS;
    let before = w.snapshot();
    assert_eq!(fire_gc(&fx, due - 1, gc_args(&gc)), Ok(()));
    assert_eq!(
        changed(&before, &w.snapshot()),
        vec!["battle_gc_sched"],
        "a premature GC deletes nothing"
    );
    let rearmed: Vec<ScheduleAt> = w
        .gcs_of(live.id)
        .iter()
        .filter(|r| r.scheduled_id != gc.scheduled_id)
        .map(|r| r.scheduled_at)
        .collect();
    assert_eq!(rearmed, vec![time(due)], "one new GC row at its own time");
}

// ===========================================================================
// BT8.7 — the shipped worst-case round in one transaction, within the chain bound
// ===========================================================================

/// Executed + Moved events whose actor is one of `units`.
fn actions_by(events: &[EventPayload], units: &[u32]) -> usize {
    events
        .iter()
        .filter(|e| match e {
            EventPayload::Moved(m) => units.contains(&m.unit),
            EventPayload::Executed(x) => units.contains(&x.attacker),
            _ => false,
        })
        .count()
}

#[test]
fn worst_case_round_runs_in_one_transaction_within_the_chain_bound_bt8_7() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &TRIO);
    let id = start(&fx, a(), seed_for(4, None), Some(3), T0);
    assert_eq!(w.tactical(id).map_id, 4, "the 8x8 open field");
    deploy(
        &fx,
        a(),
        T0 + 1_000,
        id,
        vec![pick(11, 0), pick(12, 1), pick(13, 2)],
    )
    .expect("three conscious picks deploy");
    let p: Vec<u32> = w
        .side_units(id, SideRow::A)
        .iter()
        .map(|u| u.unit_id)
        .collect();
    let q: Vec<u32> = w
        .side_units(id, SideRow::B)
        .iter()
        .map(|u| u.unit_id)
        .collect();
    assert_eq!((p.len(), q.len()), (3, 3), "six units on the board");
    let all: Vec<u32> = p.iter().chain(&q).copied().collect();

    // The round-2 boundary, seeded consistently: idle budgets, no open window, no deadline row,
    // the party on its spawn row, the pack shoulder to shoulder three rows south (inside the
    // Diamond-r1 of its centre), wilds tough and slow so the party acts first.
    for (&unit, (x, y)) in p.iter().zip([(1u8, 1u8), (3, 1), (5, 1)]) {
        w.edit_unit(unit, |u| {
            u.x = x;
            u.y = y;
            rest(u);
        });
    }
    for ((&unit, (x, y)), speed) in q.iter().zip([(2u8, 4u8), (3, 4), (4, 4)]).zip([5u16, 4, 3]) {
        w.edit_unit(unit, |u| {
            u.x = x;
            u.y = y;
            u.stats.hp = 400;
            u.cur_hp = 400;
            u.stats.speed = speed;
            rest(u);
        });
    }
    let order = all.clone();
    w.edit_tactical(id, |t| {
        t.round = 2;
        t.turn_state = TurnState::Advancing;
        t.turn_idx = 0;
        t.initiative = order;
        t.tie_priority_side = SideRow::B;
        t.pending_pad_ms = 0;
    });
    w.edit_clock(id, |c| {
        c.window_open_ms = None;
        c.deadline_ms = None;
        c.windows_this_unit_turn = 0;
    });
    for row in w.deadlines_of(id) {
        assert_eq!(w.deadlines.remove(row.scheduled_id), 1);
    }

    // Every party unit pre-queues an affordable 6-AP plan through the real reducer.
    let t1 = T0 + 2_000;
    let (p1, p2, p3) = (w.unit(p[0]), w.unit(p[1]), w.unit(p[2]));
    submit(
        &fx,
        a(),
        t1,
        id,
        p[0],
        vec![step(2, 2), light(&p1, q[0]), step(1, 1)],
    )
    .expect("move, Light, move: 2 + 2 + 2 AP");
    submit(&fx, a(), t1, id, p[1], vec![step(3, 2), heavy(&p2, q[1])])
        .expect("move, Diamond-r1 Heavy: 2 + 4 AP");
    submit(
        &fx,
        a(),
        t1,
        id,
        p[2],
        vec![step(4, 2), light(&p3, q[2]), step(5, 1)],
    )
    .expect("move, Light, move: 2 + 2 + 2 AP");
    let authored = 3 + 2 + 3;

    let t2 = T0 + 3_000;
    w.advances.seed(&TacticalAdvanceSched {
        scheduled_id: 7_001,
        scheduled_at: time(t2),
        battle_id: id,
        round: 2,
    });
    let last = w
        .events_of(id)
        .last()
        .map(|e| e.seq)
        .expect("the deploy emitted BattleStarted");
    let boundary = TacticalAdvanceSched {
        scheduled_id: 7_001,
        scheduled_at: time(t2),
        battle_id: id,
        round: 2,
    };
    fire_advance(&fx, t2, boundary).expect("the boundary fire runs the whole round");

    let fresh: Vec<EventPayload> = w
        .events_of(id)
        .into_iter()
        .filter(|e| e.seq > last)
        .map(|e| e.payload)
        .collect();
    let turn_ends = fresh
        .iter()
        .filter(|e| matches!(e, EventPayload::TurnEnded(_)))
        .count();
    let halts = fresh
        .iter()
        .filter(|e| matches!(e, EventPayload::PlanHalted(_)))
        .count();
    let kos = fresh
        .iter()
        .filter(|e| matches!(e, EventPayload::Ko(_)))
        .count();
    let round_ends: Vec<u16> = fresh
        .iter()
        .filter_map(|e| match e {
            EventPayload::RoundEnded(r) => Some(r.round),
            _ => None,
        })
        .collect();
    assert_eq!(
        turn_ends, 6,
        "all six units took their turn in the one transaction"
    );
    assert_eq!(halts, 0, "no authored entry was refused at pop");
    assert_eq!(kos, 0, "nobody fell, so every unit-turn ran");
    assert_eq!(round_ends, vec![2], "exactly one upkeep: round 2's");
    assert_eq!(
        actions_by(&fresh, &p),
        authored,
        "every pre-queued action executed: Executed + Moved == authored entries"
    );
    for &wild in &q {
        assert!(
            actions_by(&fresh, &[wild]) <= 3,
            "a wild's AI plan holds at most three actions"
        );
    }
    let total = actions_by(&fresh, &all);
    assert!(
        (authored..=18).contains(&total),
        "the chain bound: <= 18 resolved actions + one upkeep, got {total}"
    );
    let t = w.tactical(id);
    assert_eq!(
        (t.round, t.turn_state),
        (3, TurnState::Advancing),
        "the step stopped at the next boundary, never crossing it"
    );
    let next: Vec<u16> = w
        .advances_of(id)
        .iter()
        .filter(|r| r.scheduled_id != 7_001)
        .map(|r| r.round)
        .collect();
    assert_eq!(next, vec![3], "one boundary row for round 3");
}

// ===========================================================================
// Round 2 — the security-audit fixes: no-HP close of a legacy-ended anchor, the fallback
// close's owner check, the per-table firing-row exception, the deploy dry run, the reject log
// ===========================================================================

impl World<'_> {
    /// Rewrite monster `id`'s private row in place and re-derive its projection from it (the
    /// dual write a legacy write-back, a trade or a corrupt row would have left behind).
    pub(crate) fn edit_monster(&self, id: u64, f: impl FnOnce(&mut Monster)) {
        let mut m = self.monster(id);
        let tier = self.monster_pub(id).tier;
        assert_eq!(self.monsters.remove(id), 1, "monster {id} edited in place");
        assert_eq!(self.pubs.remove(id), 1, "monster_pub {id} edited in place");
        f(&mut m);
        self.pubs.seed(&pub_from_monster(&m, tier));
        self.monsters.seed(&m);
    }
}

/// Turn a live battle into a CONSISTENT round-2 boundary: every budget idle, no window open,
/// no deadline row, `Advancing` into round 2 (tie priority alternates to side B).
fn seed_round_two_boundary(w: &World<'_>, id: u64) {
    for u in w.units_of(id) {
        w.edit_unit(u.unit_id, rest);
    }
    w.edit_tactical(id, |t| {
        t.round = 2;
        t.turn_state = TurnState::Advancing;
        t.turn_idx = 0;
        t.tie_priority_side = SideRow::B;
        t.pending_pad_ms = 0;
    });
    w.edit_clock(id, |c| {
        c.window_open_ms = None;
        c.deadline_ms = None;
        c.windows_this_unit_turn = 0;
    });
    for row in w.deadlines_of(id) {
        assert_eq!(w.deadlines.remove(row.scheduled_id), 1);
    }
}

/// A legacy reducer (`submit_attack` on the anchor) ended the battle as a loss and ran its own
/// write-back: monster 11 fainted on its rows and in the anchor's team, while the tactical row
/// is still Active and u1's unit row still holds the older, higher HP.
pub(crate) fn legacy_lost_anchor(w: &World<'_>, live: &Live) {
    let mut anchor = w.anchor(live.id).expect("anchor");
    anchor.state.outcome = BattleOutcome::SideBWins;
    anchor.state.side_a.team[0].current_hp = 0;
    assert_eq!(w.battles.remove(live.id), 1);
    w.battles.seed(&anchor);
    w.edit_monster(11, |m| m.current_hp = 0);
    assert_eq!(
        w.tactical(live.id).phase,
        Phase::Active,
        "PRECONDITION: the tactical row is still Active"
    );
    assert_eq!(
        w.unit(live.u1).cur_hp,
        300,
        "PRECONDITION: the unit row holds the higher HP a wrong close would write back"
    );
}

/// The tactical side is closed, exactly one GC row is armed 24 h after `now`, and no deadline
/// or advance row of the battle survives except the FIRING row of its own table (which the
/// runtime deletes itself after the reducer returns).
fn assert_closed_sparing(
    w: &World<'_>,
    id: u64,
    now: i64,
    firing_deadline: Option<u64>,
    firing_advance: Option<u64>,
) {
    let t = w.tactical(id);
    assert_eq!(
        (t.phase, t.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    let deadlines: Vec<u64> = w
        .deadlines_of(id)
        .iter()
        .map(|r| r.scheduled_id)
        .filter(|&sid| Some(sid) != firing_deadline)
        .collect();
    assert!(
        deadlines.is_empty(),
        "every deadline row but the firing one is swept: {deadlines:?}"
    );
    let advances: Vec<u64> = w
        .advances_of(id)
        .iter()
        .map(|r| r.scheduled_id)
        .filter(|&sid| Some(sid) != firing_advance)
        .collect();
    assert!(
        advances.is_empty(),
        "every advance row but the firing one is swept: {advances:?}"
    );
    let gcs: Vec<ScheduleAt> = w.gcs_of(id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(now + GC_DELAY_MS)], "exactly one GC row");
}

#[test]
fn deadline_fire_after_a_legacy_reducer_ended_the_anchor_closes_without_reviving_hp_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let window = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    legacy_lost_anchor(&w, &live);
    w.deadlines.seed(&TacticalDeadlineSched {
        scheduled_id: 9_501,
        scheduled_at: time(deadline + 50),
        battle_id: live.id,
        unit_id: live.u2,
        window_seq: 0,
    });
    w.advances.seed(&TacticalAdvanceSched {
        scheduled_id: 9_502,
        scheduled_at: time(deadline),
        battle_id: live.id,
        round: 2,
    });
    let anchor = enc(&w.anchor(live.id).expect("anchor"));
    let party = (row_set(&w.monsters.rows()), row_set(&w.pubs.rows()));

    assert_eq!(fire_deadline(&fx, deadline, deadline_args(&window)), Ok(()));

    assert_eq!(
        w.monster(11).current_hp,
        0,
        "the fire must not revive the monster the legacy write-back left fainted"
    );
    assert_eq!(
        (row_set(&w.monsters.rows()), row_set(&w.pubs.rows())),
        party,
        "this close writes no HP at all"
    );
    let after = w.anchor(live.id).expect("the anchor survives");
    assert_eq!(
        after.state.outcome,
        BattleOutcome::SideBWins,
        "the legacy outcome is kept, never overwritten with Fled"
    );
    assert_eq!(enc(&after), anchor, "the anchor row is untouched");
    assert_closed_sparing(&w, live.id, deadline, Some(window.scheduled_id), None);
}

#[test]
fn advance_fire_after_a_legacy_reducer_ended_the_anchor_closes_without_reviving_hp_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seed_round_two_boundary(&w, live.id);
    let t = T0 + 50_000;
    let boundary = TacticalAdvanceSched {
        scheduled_id: 9_601,
        scheduled_at: time(t),
        battle_id: live.id,
        round: 2,
    };
    w.advances.seed(&advance_args(&boundary));
    w.advances.seed(&TacticalAdvanceSched {
        scheduled_id: 9_602,
        scheduled_at: time(t),
        battle_id: live.id,
        round: 2,
    });
    // A stale deadline row whose id equals the firing ADVANCE row's (each table has its own
    // id sequence): it is not the firing row, so it must go.
    w.deadlines.seed(&TacticalDeadlineSched {
        scheduled_id: 9_601,
        scheduled_at: time(t),
        battle_id: live.id,
        unit_id: live.u1,
        window_seq: 1,
    });
    legacy_lost_anchor(&w, &live);
    let anchor = enc(&w.anchor(live.id).expect("anchor"));
    let party = (row_set(&w.monsters.rows()), row_set(&w.pubs.rows()));

    assert_eq!(fire_advance(&fx, t, boundary), Ok(()));

    assert_eq!(
        w.monster(11).current_hp,
        0,
        "the fire must not revive the monster the legacy write-back left fainted"
    );
    assert_eq!(
        (row_set(&w.monsters.rows()), row_set(&w.pubs.rows())),
        party,
        "this close writes no HP at all"
    );
    let after = w.anchor(live.id).expect("the anchor survives");
    assert_eq!(
        after.state.outcome,
        BattleOutcome::SideBWins,
        "the legacy outcome is kept, never overwritten with Fled"
    );
    assert_eq!(enc(&after), anchor, "the anchor row is untouched");
    assert_closed_sparing(&w, live.id, t, None, Some(9_601));
}

#[test]
fn fallback_close_never_writes_hp_into_a_monster_traded_away_mid_battle_bt8_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.edit_unit(live.u1, |u| u.cur_hp = 170);
    w.edit_unit(live.u2, |u| u.cur_hp = 150);
    w.edit_monster(12, |m| m.owner_identity = b());
    w.edit_tactical(live.id, |t| t.content_version = crate::CONTENT_VERSION + 1);
    let traded = (enc(&w.monster(12)), enc(&w.monster_pub(12)));
    let t2 = T0 + 7_000;

    super::resolve_tactical_on_disconnect(&fx.ctx_at(at(t2)), a());

    assert_eq!(
        (enc(&w.monster(12)), enc(&w.monster_pub(12))),
        traded,
        "a monster now owned by someone else never receives the unit's HP"
    );
    assert_eq!(
        (w.monster(11).current_hp, w.monster_pub(11).current_hp),
        (170, 170),
        "the still-owned deployed monster's HP IS persisted"
    );
    let anchor = w
        .anchor(live.id)
        .expect("the anchor is updated, never deleted");
    assert_eq!(anchor.state.outcome, BattleOutcome::Fled);
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    let gcs: Vec<ScheduleAt> = w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t2 + GC_DELAY_MS)], "exactly one GC row");
}

#[test]
fn finish_spares_only_the_firing_row_of_its_own_schedule_table_bt8_3() {
    // Deadline path: an AutoFlee expiry. The extra ADVANCE row deliberately carries the firing
    // deadline row's id — sparing by a bare id would keep it.
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        let window = w.only_deadline(live.id);
        let deadline = w.clock(live.id).deadline_ms.expect("an open window");
        w.advances.seed(&TacticalAdvanceSched {
            scheduled_id: window.scheduled_id,
            scheduled_at: time(deadline),
            battle_id: live.id,
            round: 2,
        });
        w.deadlines.seed(&TacticalDeadlineSched {
            scheduled_id: window.scheduled_id + 1_000,
            scheduled_at: time(deadline + 50),
            battle_id: live.id,
            unit_id: live.u2,
            window_seq: 0,
        });
        assert_eq!(fire_deadline(&fx, deadline, deadline_args(&window)), Ok(()));
        assert_eq!(
            w.anchor(live.id).expect("anchor").state.outcome,
            BattleOutcome::Fled,
            "the wild expiry auto-fled"
        );
        assert!(
            w.advances_of(live.id).is_empty(),
            "the extra advance row goes even though its id equals the firing deadline row's"
        );
        assert_closed_sparing(&w, live.id, deadline, Some(window.scheduled_id), None);
    }
    // Advance path: the fired round runs u1's READY Flee and finishes the battle. The extra
    // DEADLINE row carries the firing advance row's id.
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        seed_round_two_boundary(&w, live.id);
        let t1 = T0 + 50_000;
        submit(&fx, a(), t1, live.id, live.u1, vec![QueuedAction::Flee])
            .expect("a Flee pre-queued during Advancing");
        let boundary = TacticalAdvanceSched {
            scheduled_id: 9_701,
            scheduled_at: time(t1),
            battle_id: live.id,
            round: 2,
        };
        w.advances.seed(&advance_args(&boundary));
        w.advances.seed(&TacticalAdvanceSched {
            scheduled_id: 9_702,
            scheduled_at: time(t1),
            battle_id: live.id,
            round: 2,
        });
        w.deadlines.seed(&TacticalDeadlineSched {
            scheduled_id: 9_701,
            scheduled_at: time(t1),
            battle_id: live.id,
            unit_id: live.u1,
            window_seq: 1,
        });
        let t2 = T0 + 51_000;
        assert_eq!(fire_advance(&fx, t2, boundary), Ok(()));
        assert_eq!(
            w.anchor(live.id).expect("anchor").state.outcome,
            BattleOutcome::Fled,
            "the fired round executed u1's READY Flee"
        );
        assert!(
            w.deadlines_of(live.id).is_empty(),
            "the deadline row goes even though its id equals the firing advance row's"
        );
        assert_closed_sparing(&w, live.id, t2, None, Some(9_701));
    }
}

#[test]
fn deploy_units_refuses_a_pick_the_rules_reject_before_inserting_any_unit_bt8_2() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pair(&fx, &w);
    // Monster 12's row passes every reducer-level pick check (owned, in the party, conscious,
    // free) but the rules refuse it (`deploy_unit`: 0 defense). It is the SECOND pick, so a
    // shell that inserts as it goes would already have written monster 11's unit row.
    w.edit_monster(12, |m| m.stat_defense = 0);
    let before = w.snapshot();
    let err = deploy(&fx, a(), T0 + 1_000, id, vec![pick(11, 0), pick(12, 1)])
        .expect_err("a pick the rules refuse is refused");
    assert!(
        err.starts_with("deploy: ZeroDefense"),
        "the rules' own typed refusal, got {err:?}"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "the dry run refuses before the first battle_unit insert"
    );
    assert_eq!(w.tactical(id).phase, Phase::Deploying);
}

/// Every `log` record of this test PROCESS as `(target, line)`. NEXTEST-ONLY, like
/// `taming_tests.rs`'s `TmLogSink`: one logger may be installed per process, so plain
/// `cargo test` (one process for every test) fails all but the first installer.
struct RejectLogSink(std::sync::Mutex<Vec<(String, String)>>);

impl log::Log for RejectLogSink {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((record.target().to_string(), record.args().to_string()));
    }
    fn flush(&self) {}
}

static REJECT_LOGS: RejectLogSink = RejectLogSink(std::sync::Mutex::new(Vec::new()));

#[test]
fn submit_queue_refusal_emits_one_structured_reject_log_line_bt8_1() {
    log::set_logger(&REJECT_LOGS).expect("no logger installed in this test process (nextest)");
    log::set_max_level(log::LevelFilter::Info);
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let stranger = b();
    let got = submit(
        &fx,
        stranger,
        T0 + 1_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    );
    assert_eq!(got, Err("not owner".to_string()));
    let rejects: Vec<(String, String)> = REJECT_LOGS
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, line)| line.contains("\"evt\":\"reject\""))
        .cloned()
        .collect();
    let want = format!(
        "{{\"evt\":\"reject\",\"reducer\":\"submit_queue\",\"sender\":\"{stranger}\",\"reason\":\"not owner\"}}"
    );
    assert_eq!(
        rejects,
        vec![("monster_realm_module::guards".to_string(), want)],
        "the refusal is logged exactly once through guards::log_reject"
    );
}
