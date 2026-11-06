//! Tactical battles (M-battle-tactics bt-8) — the wild engine's imperative shell.
//!
//! Every rule lives in `game_core::tactics`: this module hydrates the bt-7 rows into a
//! [`TacticalBattle`], hands it ONE input (`start` / `advance` / `submit_queue` /
//! `cancel_queue` / `expire` / `conclude`), writes the rows back, and arms or disarms the
//! schedule rows the step asks for (a clock window → one `tactical_deadline_sched` row
//! pinned by `(battle_id, unit_id, window_seq)` at the clock's own deadline; a round
//! boundary → one zero-delay `tactical_advance_sched` row pinned by `(battle_id, round)`;
//! a finish → one `battle_gc_sched` row 24 h out). The planner, the inventory and the
//! delegated entries reach the executor only through `queue::Hooks`, implemented here
//! over rows. Content (kits, maps, tuning, the type chart, the encounter tables) is the
//! game-core embedded registry, parsed once per process — the same bytes `sync_content`
//! seeds the tables from.
//!
//! Identity comes from `ctx.sender()` on every client reducer; the scheduled reducers
//! refuse any sender but the database identity and otherwise never fail (a battle that
//! cannot be loaded is closed by [`fallback_close`], never left `Ongoing`); every
//! refusal is an `Err` (never a clamp) that also goes through `guards::log_reject`.
//!
//! Settlement (bt-9) lives in `tactics_settle`: `finish` hands it the close kind, and it pays
//! the reward ledger folded from the transcript, applies the faint penalty, sweeps the player's
//! prior terminal battles (their tactical rows included) and finalises the `battle_summary` row
//! `store` accumulates every step. The recruit glue is the `Hooks` impl here: the bait's content
//! row, the wild's seed row, its species and level are all resolved BEFORE the executor debits
//! the bait (R-21r-a-CONTENTLOAD), the roll is game-core's (`recruit::resolve_recruit`, the
//! private stream), the H1/H2 `playtest_event` row is written with the pre-roll HP, and a
//! success rebuilds the wild through `taming::insert_recruited`. `Item` entries stay refused at
//! submit and at pop: the item rule has no game-core home yet (R-bt-8-ITEMRULE).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use crate::battle::{lead_party, lead_party_ids, write_back_party_hp};
use crate::content_cache::{
    cached_battle_maps, cached_tactics_items, cached_tactics_skills, cached_tactics_species,
    cached_tactics_zones,
};
use crate::guards::{
    check_monster_in_party, check_party_size, escrowed_item_qty, is_in_ongoing_battle, json_escape,
    log_reject, reject_if_monster_in_trade, require_subject_not_deleting,
};
use crate::inventory::consume_one;
use crate::marshal::now_ms;
use crate::monster_mgmt::update_monster_synced;
use crate::observability::mr_log;
use crate::playtest::{hp_permille, record_recruit_event};
use crate::pvp::{challenge_format, SideAWriteBack, PVP_FORMAT_MAX};
use crate::schema::{
    battle, battle_clock, battle_deploy, battle_event, battle_queue, battle_secret,
    battle_tactical, battle_unit, battle_wild_unit, character, inventory, monster, player,
    player_formation, trade_offer, Battle, BattleClock, BattleDeploy, BattleEvent, BattleQueue,
    BattleSecret, BattleTactical, BattleUnit, BattleWildUnit, BudgetLastEntry, BudgetMoveSpend,
    DeployPick, Monster, MoveClassRow, PlayerFormation, SideRow, StanceRow,
};
use crate::tactics_settle::{self, mark_first_recruit, Close, StepPrev};
use crate::taming::insert_recruited;
use crate::{CONTENT_VERSION, WILD_IDENTITY};
use game_core::tactics::ai;
use game_core::tactics::queue::is_player_owned;
use game_core::tactics::resolve::UnitState;
use game_core::tactics::types::{ActionKind, Phase, QueuedAction, TurnState, MAX_STORED_ENTRIES};
use game_core::tactics::{
    deploy_unit, generate_encounter, recruit_preflight, resolve_recruit, splitmix64,
    stride_for_base_speed, validate_tactics_content, wild_seed, AdvancePin, BattleKind,
    BattleMapDef, BattleMapEntry, Cell, ClockState, EndHow, Entry, EventPayload, ExpireError,
    HaltReason, Hooks, MoveClass, ReadyPlan, RecruitError, Rules, Side, SpeciesTactics, Stance,
    StepResult, TacticalBattle, TacticalState, TacticalUnit, TacticsRegistries, TacticsTuning,
    TacticsZoneDef, Tier, TurnBudget, UnitKit, Validated, MAX_PACK,
};
use game_core::{
    build_monster, load_encounters, load_items, load_skills, load_species, load_tactics_tuning,
    load_type_chart, load_zones, pvp_forfeit_outcome, resolve_encounter, BattleMonster,
    BattleOutcome, BattleSide, BattleState, EncounterTable, ItemDef, Level, SideId, Species,
    StatBlock, TypeChart,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp};

/// Delay between a battle's finish and the sweep of its per-battle rows (design §8.1).
pub(crate) const GC_DELAY_MS: i64 = 86_400_000;
/// The Deploying window's deadline row carries this `unit_id` (unit ids are `auto_inc`
/// from 1) and `window_seq` 0. Frozen once shipped: a fired row is matched on it.
pub(crate) const DEPLOY_WINDOW_UNIT: u32 = 0;
/// `battle_secret.seed = splitmix64(encounter_seed ^ BATTLE_SEED_SALT)`: the roll stream
/// must never equal the per-wild individuality seeds (`encounter::wild_seed` is the same
/// mixer over the raw encounter seed).
pub(crate) const BATTLE_SEED_SALT: u64 = 0x7A57_1C5B_A771_E5EE;
/// The per-wild species/level roll's seed is `splitmix64(wild_seed ^ SPAWN_ROLL_SALT) >> 32`:
/// decorrelated from the wild's individuality seed (same mixer) while §3.4's
/// `individuality_seed = wild_seed(seed, i)` is kept.
const SPAWN_ROLL_SALT: u64 = 0x5BA7_0E5E_ED11_C0DE;
/// The PvP map pick is `pvp_maps[splitmix64(seed ^ PVP_MAP_SALT) % n]`: decorrelated from the roll
/// stream (`BATTLE_SEED_SALT`) and the wild spawn roll (`SPAWN_ROLL_SALT`), same mixer.
pub(crate) const PVP_MAP_SALT: u64 = 0x9E37_79B9_7F4A_7C15;
/// A wild battle: side A is the player, side B the pack (design §2.2).
const WILD_FORMAT: u8 = 0;
/// Item entries are refused at submit: the item rule (range, Ally filter, cure match) has no
/// game-core home yet (R-bt-8-ITEMRULE), and the shell restates no rule.
const ITEMS_NOT_AVAILABLE: &str = "items are not available in tactical battles";

// ===========================================================================
// Scheduled tables (colocated with their reducers; PRIVATE)
// ===========================================================================

/// One-shot clock-window deadline (design §2.3): one row per window, pinned by
/// `(battle_id, unit_id, window_seq)`; the Deploying window rides it with
/// `unit_id == DEPLOY_WINDOW_UNIT`, `window_seq == 0`. A stale fire is a no-op.
#[spacetimedb::table(accessor = tactical_deadline_sched, scheduled(tactical_deadline_fire))]
pub struct TacticalDeadlineSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
    pub unit_id: u32,
    pub window_seq: u32,
}

/// Zero-delay round-boundary continuation (design §2.2 chain rule), pinned by
/// `(battle_id, round)` — `round` is the round about to start.
#[spacetimedb::table(accessor = tactical_advance_sched, scheduled(tactical_advance))]
pub struct TacticalAdvanceSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
    pub round: u16,
}

/// The 24 h sweep of a finished battle's per-battle rows (design §8.1 GC).
#[spacetimedb::table(accessor = battle_gc_sched, scheduled(battle_gc))]
pub struct BattleGcSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
}

// ===========================================================================
// Marshal twins — exhaustive matches between game-core's non-wire enums and the
// schema-local `SpacetimeType` twins (bt-7). Pure.
// ===========================================================================

fn side_row(side: Side) -> SideRow {
    match side {
        Side::A => SideRow::A,
        Side::B => SideRow::B,
    }
}

fn side_of_row(row: SideRow) -> Side {
    match row {
        SideRow::A => Side::A,
        SideRow::B => Side::B,
    }
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

fn stance_of_row(row: StanceRow) -> Stance {
    match row {
        StanceRow::Aggressive => Stance::Aggressive,
        StanceRow::Territorial => Stance::Territorial,
        StanceRow::Skittish => Stance::Skittish,
    }
}

fn budget_last_row(last: Option<Entry>) -> Option<BudgetLastEntry> {
    last.map(|entry| match entry {
        Entry::Move { strides, taxed } => BudgetLastEntry::Move(BudgetMoveSpend { strides, taxed }),
        Entry::Attack(Tier::Light) => BudgetLastEntry::AttackLight,
        Entry::Attack(Tier::Heavy) => BudgetLastEntry::AttackHeavy,
        Entry::Item => BudgetLastEntry::Item,
        Entry::Recruit => BudgetLastEntry::Recruit,
        Entry::Flee => BudgetLastEntry::Flee,
        Entry::EndTurn => BudgetLastEntry::EndTurn,
    })
}

fn budget_last_of_row(row: Option<BudgetLastEntry>) -> Option<Entry> {
    row.map(|entry| match entry {
        BudgetLastEntry::Move(BudgetMoveSpend { strides, taxed }) => Entry::Move { strides, taxed },
        BudgetLastEntry::AttackLight => Entry::Attack(Tier::Light),
        BudgetLastEntry::AttackHeavy => Entry::Attack(Tier::Heavy),
        BudgetLastEntry::Item => Entry::Item,
        BudgetLastEntry::Recruit => Entry::Recruit,
        BudgetLastEntry::Flee => Entry::Flee,
        BudgetLastEntry::EndTurn => Entry::EndTurn,
    })
}

fn side_index(side: Side) -> usize {
    match side {
        Side::A => 0,
        Side::B => 1,
    }
}

fn ms_to_timestamp(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms.saturating_mul(1_000))
}

// ===========================================================================
// Content — the game-core embedded registries, joined once per process.
// ===========================================================================

/// Everything the rules need that is content, not state.
struct TacticsContent {
    tuning: TacticsTuning,
    chart: TypeChart,
    species: Vec<Species>,
    items: Vec<ItemDef>,
    kits: Vec<SpeciesTactics>,
    maps: &'static [BattleMapEntry],
    zones: &'static [TacticsZoneDef],
    encounters: Vec<EncounterTable>,
}

fn load_content() -> Result<TacticsContent, String> {
    let species = load_species().map_err(|e| format!("tactics content: species: {e}"))?;
    let skills = load_skills().map_err(|e| format!("tactics content: skills: {e}"))?;
    let items = load_items().map_err(|e| format!("tactics content: items: {e}"))?;
    let zones = load_zones().map_err(|e| format!("tactics content: zones: {e}"))?;
    let relations = load_type_chart().map_err(|e| format!("tactics content: type chart: {e}"))?;
    let encounters = load_encounters().map_err(|e| format!("tactics content: encounters: {e}"))?;
    let tuning = load_tactics_tuning().map_err(|e| format!("tactics content: tuning: {e:?}"))?;
    let maps = cached_battle_maps()?;
    let tactics_zones = cached_tactics_zones()?;
    let kits = validate_tactics_content(&TacticsRegistries {
        species: &species,
        skills: &skills,
        items: &items,
        zones: &zones,
        tactics_skills: cached_tactics_skills()?,
        tactics_species: cached_tactics_species()?,
        tactics_items: cached_tactics_items()?,
        tactics_zones,
        battle_maps: maps,
        tuning: &tuning,
    })
    .map_err(|e| format!("tactics content: {e:?}"))?;
    Ok(TacticsContent {
        tuning,
        chart: TypeChart::new(&relations),
        species,
        items,
        kits,
        maps,
        zones: tactics_zones,
        encounters,
    })
}

static CONTENT: LazyLock<Result<TacticsContent, String>> = LazyLock::new(load_content);

/// The content species `species_id` (the settlement's BST and level-up base stats).
pub(crate) fn content_species(species_id: u32) -> Option<&'static Species> {
    content().ok().and_then(|c| c.species(species_id).ok())
}

fn content() -> Result<&'static TacticsContent, String> {
    (*CONTENT).as_ref().map_err(Clone::clone)
}

impl TacticsContent {
    fn species(&self, id: u32) -> Result<&Species, String> {
        self.species
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("species {id} not in content"))
    }

    /// A bait's bonus (‰): `None` for an unknown item or one with no recruit function.
    fn bait_bonus(&self, item_id: u32) -> Option<u16> {
        self.items
            .iter()
            .find(|i| i.id == item_id)
            .map(|i| i.recruit_bonus)
            .filter(|&bonus| bonus > 0)
    }

    fn kit(&self, species_id: u32) -> Result<&SpeciesTactics, String> {
        self.kits
            .iter()
            .find(|k| k.species_id == species_id)
            .ok_or_else(|| format!("species {species_id} has no tactical kit"))
    }

    fn map(&self, map_id: u32) -> Result<&'static BattleMapDef, String> {
        self.maps
            .iter()
            .find(|m| m.id == map_id)
            .map(|m| &m.map)
            .ok_or_else(|| format!("battle map {map_id} not in content"))
    }

    fn zone(&self, zone_id: u32) -> Result<&TacticsZoneDef, String> {
        self.zones
            .iter()
            .find(|z| z.zone_id == zone_id)
            .ok_or_else(|| format!("no tactics zone for zone {zone_id}"))
    }

    fn encounter(&self, zone_id: u32) -> Result<&EncounterTable, String> {
        self.encounters
            .iter()
            .find(|t| t.zone_id == zone_id)
            .ok_or_else(|| format!("no encounter table for zone {zone_id}"))
    }

    /// The battler of `species_id` at `level` with the given derived stats (bt-6's kit join).
    fn unit_kit(&self, species_id: u32, level: u8, stats: StatBlock) -> Result<UnitKit, String> {
        let species = self.species(species_id)?;
        let kit = self.kit(species_id)?;
        Ok(UnitKit {
            species_id,
            affinity: species.affinity,
            level,
            stats,
            base_speed: kit.base_speed,
            class: kit.movement,
            skills: vec![kit.light.clone(), kit.heavy.clone()],
        })
    }

    fn rules(&self) -> Rules<'_> {
        Rules {
            chart: &self.chart,
            tuning: &self.tuning,
        }
    }
}

// ===========================================================================
// Hydration — rows ⇄ `TacticalBattle`
// ===========================================================================

/// The schedule row currently firing, if any — spared by the bulk disarms (the runtime
/// deletes the fired row itself). Tagged per table: each table has its own id sequence.
#[derive(Clone, Copy)]
enum Except {
    None,
    Deadline(u64),
    Advance(u64),
}

impl Except {
    fn deadline(self) -> Option<u64> {
        match self {
            Except::Deadline(id) => Some(id),
            Except::None | Except::Advance(_) => None,
        }
    }

    fn advance(self) -> Option<u64> {
        match self {
            Except::Advance(id) => Some(id),
            Except::None | Except::Deadline(_) => None,
        }
    }
}

/// The turn-machine facts before a step: what `store` arms an advance row against, and what
/// the summary's per-step delta needs (bt-9).
#[derive(Clone)]
struct Prev {
    turn: TurnState,
    round: u16,
    /// Windows opened so far in the waiting unit's turn (its side's clock).
    windows: u8,
    /// Units at full HP before the step (the single-hit KO telemetry).
    full_hp: Vec<u32>,
}

fn prev_of(tb: &TacticalBattle) -> Prev {
    Prev {
        turn: tb.turn_state,
        round: tb.state.round,
        windows: match tb.turn_state {
            TurnState::Waiting(unit) => {
                tb.state
                    .unit(unit)
                    .map_or(tb.clocks[0], |u| tb.clocks[side_index(u.side)])
                    .windows_this_unit_turn
            }
            TurnState::NotActive | TurnState::Advancing => tb.clocks[0].windows_this_unit_turn,
        },
        full_hp: tb
            .state
            .units
            .iter()
            .filter(|u| u.cur_hp == u.max_hp())
            .map(|u| u.id)
            .collect(),
    }
}

/// A tactical battle composed from its rows for one transaction.
struct Loaded {
    anchor: Battle,
    tactical: BattleTactical,
    units: Vec<BattleUnit>,
    map: &'static BattleMapDef,
    tb: TacticalBattle,
}

fn monster_stats(m: &Monster) -> StatBlock {
    StatBlock {
        hp: m.stat_hp,
        attack: m.stat_attack,
        defense: m.stat_defense,
        speed: m.stat_speed,
        sp_attack: m.stat_sp_attack,
        sp_defense: m.stat_sp_defense,
    }
}

/// One `battle_unit` row as the rules see it. Field by field: never through
/// `TacticalState::new` or `deploy_unit`, which refuse fainted units and reset state.
fn unit_of_row(row: &BattleUnit, content: &TacticsContent) -> Result<TacticalUnit, String> {
    let kit = content.unit_kit(row.species_id, row.level, row.stats)?;
    Ok(TacticalUnit {
        id: row.unit_id,
        side: side_of_row(row.side),
        slot: row.slot,
        kit,
        pos: Cell { x: row.x, y: row.y },
        cur_hp: row.cur_hp,
        status: row.status,
        budget: TurnBudget {
            ap: row.ap,
            strides_used: row.strides_used,
            attacks: row.attacks,
            last: budget_last_of_row(row.budget_last),
        },
        guard: row.guard,
        first_stand: row.first_stand,
        state: row.state,
    })
}

fn clock_of_row(row: &BattleClock) -> ClockState {
    ClockState {
        window_seq: row.window_seq,
        window_open_ms: row.window_open_ms,
        // The engine's clock holds a deadline only while a window is open. A Deploying row carries
        // the deploy deadline with no open window (bt-12 B, for the client's countdown); nothing
        // loads a Deploying battle today, but a future reader must never see a half-open window.
        deadline_ms: row.window_open_ms.and(row.deadline_ms),
        windows_this_unit_turn: row.windows_this_unit_turn,
        idle_ms_total: row.idle_ms_total,
        autopass_count: row.autopass_count,
    }
}

/// Compose the battle. `Err` when any row the rules need is missing, when the content
/// the rows were written under is gone (`content_version` drift, an unknown kit or map)
/// — the callers close such a battle through [`fallback_close`], never leave it live.
fn load(ctx: &ReducerContext, battle_id: u64) -> Result<Loaded, String> {
    let anchor = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    let tactical = ctx
        .db
        .battle_tactical()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "not a tactical battle".to_string())?;
    if tactical.content_version != CONTENT_VERSION {
        return Err(format!(
            "battle {battle_id} was written under content version {} (live {CONTENT_VERSION})",
            tactical.content_version
        ));
    }
    let secret = ctx
        .db
        .battle_secret()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| format!("battle {battle_id} has no secret row"))?;
    let content = content()?;
    let map = content.map(tactical.map_id)?;
    let mut rows: Vec<BattleUnit> = ctx.db.battle_unit().battle_id().filter(battle_id).collect();
    rows.sort_by_key(|u| (u.side as u8, u.slot));
    let mut units = Vec::with_capacity(rows.len());
    for row in &rows {
        units.push(unit_of_row(row, content)?);
    }
    let clock_rows: Vec<BattleClock> = ctx
        .db
        .battle_clock()
        .battle_id()
        .filter(battle_id)
        .collect();
    let clock_a = clock_rows
        .iter()
        .find(|c| c.side == SideRow::A)
        .ok_or_else(|| format!("battle {battle_id} has no side-A clock row"))?;
    // A wild side never runs a clock; under the PvP ruleset side B's row is as load-bearing as
    // A's (its windows, idle time and strikes live there).
    let clock_b = match clock_rows.iter().find(|c| c.side == SideRow::B) {
        Some(row) => clock_of_row(row),
        None if tactical.kind.uses_pvp_rules() => {
            return Err(format!("battle {battle_id} has no side-B clock row"))
        }
        None => ClockState::default(),
    };
    let mut plans: Vec<ReadyPlan> = ctx
        .db
        .battle_queue()
        .battle_id()
        .filter(battle_id)
        .map(|q| ReadyPlan {
            unit: q.unit_id,
            entries: q.entries,
        })
        .collect();
    plans.sort_by_key(|p| p.unit);
    let state = TacticalState {
        kind: tactical.kind,
        seed: secret.seed,
        action_seq: secret.action_seq,
        round: tactical.round,
        width: map.width,
        height: map.height,
        terrain: map.tiles.iter().map(|t| t.terrain).collect(),
        blocks_los: map.tiles.iter().map(|t| t.blocks_los).collect(),
        units,
        initiative: tactical.initiative.clone(),
        queued: Vec::new(),
        attack_damage_dealt: [
            tactical.attack_damage_dealt_a,
            tactical.attack_damage_dealt_b,
        ],
        outcome: anchor.state.outcome,
    };
    let tb = TacticalBattle {
        battle_id,
        state,
        plans,
        turn_state: tactical.turn_state,
        clocks: [clock_of_row(clock_a), clock_b],
        pending_pad_ms: tactical.pending_pad_ms,
    };
    Ok(Loaded {
        anchor,
        tactical,
        units: rows,
        map,
        tb,
    })
}

/// Copy every deployed unit's HP into the anchor's legacy teams (side A by `party_monster_ids`,
/// side B by `opponent_monster_ids`), so the write-back primitives and every legacy reader see the
/// tactical truth.
fn mirror_hp(anchor: &mut Battle, units: &[BattleUnit]) {
    for unit in units {
        let Some(mid) = unit.monster_id else {
            continue;
        };
        // Each side mirrors into its own anchor team by its own id list (disjoint by construction,
        // Practice included — `start_pvp_tactical` refuses a monster on both sides).
        let (ids, team) = match unit.side {
            SideRow::A => (&anchor.party_monster_ids, &mut anchor.state.side_a.team),
            SideRow::B => (&anchor.opponent_monster_ids, &mut anchor.state.side_b.team),
        };
        match ids.iter().position(|&m| m == mid) {
            Some(i) => {
                if let Some(bm) = team.get_mut(i) {
                    bm.current_hp = unit.cur_hp;
                }
            }
            None => mr_log(
                "tactical_unit_outside_party",
                &format!(
                    "\"battle_id\":{},\"unit_id\":{},\"monster_id\":{mid}",
                    unit.battle_id, unit.unit_id
                ),
            ),
        }
    }
}

pub(crate) fn next_event_seq(ctx: &ReducerContext, battle_id: u64) -> u32 {
    ctx.db
        .battle_event()
        .battle_id()
        .filter(battle_id)
        .map(|e| e.seq)
        .max()
        .map_or(0, |m| m.saturating_add(1))
}

fn arm_deadline(ctx: &ReducerContext, battle_id: u64, unit_id: u32, window_seq: u32, at_ms: i64) {
    ctx.db
        .tactical_deadline_sched()
        .insert(TacticalDeadlineSched {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(ms_to_timestamp(at_ms)),
            battle_id,
            unit_id,
            window_seq,
        });
}

fn arm_advance(ctx: &ReducerContext, pin: AdvancePin, now_ms: i64) {
    ctx.db
        .tactical_advance_sched()
        .insert(TacticalAdvanceSched {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(ms_to_timestamp(now_ms)),
            battle_id: pin.battle_id,
            round: pin.round,
        });
}

fn arm_gc(ctx: &ReducerContext, battle_id: u64, at_ms: i64) {
    ctx.db.battle_gc_sched().insert(BattleGcSched {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(ms_to_timestamp(at_ms)),
        battle_id,
    });
}

/// Delete the battle's deadline rows (collect-before-delete), sparing `except` — the row
/// currently firing, which the runtime deletes itself after the reducer returns.
fn disarm_deadlines(ctx: &ReducerContext, battle_id: u64, except: Option<u64>) {
    let ids: Vec<u64> = ctx
        .db
        .tactical_deadline_sched()
        .battle_id()
        .filter(battle_id)
        .map(|r| r.scheduled_id)
        .filter(|id| Some(*id) != except)
        .collect();
    for id in ids {
        ctx.db.tactical_deadline_sched().scheduled_id().delete(id);
    }
}

fn disarm_advances(ctx: &ReducerContext, battle_id: u64, except: Option<u64>) {
    let ids: Vec<u64> = ctx
        .db
        .tactical_advance_sched()
        .battle_id()
        .filter(battle_id)
        .map(|r| r.scheduled_id)
        .filter(|id| Some(*id) != except)
        .collect();
    for id in ids {
        ctx.db.tactical_advance_sched().scheduled_id().delete(id);
    }
}

fn disarm_gcs(ctx: &ReducerContext, battle_id: u64, except: Option<u64>) {
    let ids: Vec<u64> = ctx
        .db
        .battle_gc_sched()
        .battle_id()
        .filter(battle_id)
        .map(|r| r.scheduled_id)
        .filter(|id| Some(*id) != except)
        .collect();
    for id in ids {
        ctx.db.battle_gc_sched().scheduled_id().delete(id);
    }
}

/// Write one step back: the anchor HP mirror, the tactical row, the secret, every unit,
/// the READY rows (reconciled), every clock row, the events, then the schedule rows the
/// step asks for — each row only when it moved. `prev` is the turn state and round before the step: an advance row is
/// armed only when the step ended in `Advancing` AND moved the boundary (it entered
/// `Advancing`, or a fired advance ran a whole round into the next boundary) — a pre-queue
/// or cancel during `Advancing` arms nothing. A finished battle goes through [`finish`].
fn store(
    ctx: &ReducerContext,
    loaded: Loaded,
    out: &StepResult,
    prev: Prev,
    now_ms: i64,
    except: Except,
) {
    let Loaded {
        mut anchor,
        mut tactical,
        units,
        map: _,
        tb,
    } = loaded;
    let battle_id = tb.battle_id;
    // Units first: the mirror below reads the written HP.
    let mut written: Vec<BattleUnit> = Vec::with_capacity(units.len());
    for row in units {
        let Some(u) = tb.state.unit(row.unit_id) else {
            written.push(row);
            continue;
        };
        let before = row.clone();
        let next = BattleUnit {
            x: u.pos.x,
            y: u.pos.y,
            cur_hp: u.cur_hp,
            status: u.status,
            ap: u.budget.ap,
            strides_used: u.budget.strides_used,
            attacks: u.budget.attacks,
            budget_last: budget_last_row(u.budget.last),
            guard: u.guard,
            first_stand: u.first_stand,
            state: u.state,
            ..row
        };
        if next != before {
            ctx.db.battle_unit().unit_id().update(next.clone());
        }
        written.push(next);
    }
    // Rows are written only when they MOVED: an unchanged update still reaches every subscriber,
    // and under the PvP ruleset that subscriber is the opponent — a pre-queue or a cancel must
    // leave nothing participant-visible behind (design §6.3, BT14.4).
    let anchor_before = anchor.clone();
    mirror_hp(&mut anchor, &written);
    let finished = tb.phase() == Phase::Finished;
    if finished {
        anchor.state.outcome = tb.state.outcome;
    }
    if anchor != anchor_before {
        ctx.db.battle().battle_id().update(anchor.clone());
    }
    // The tactical row (`finish` flips the phase itself; its idempotency reads it).
    let tactical_before = tactical.clone();
    if !finished {
        tactical.phase = tb.phase();
    }
    tactical.round = tb.state.round;
    tactical.initiative = tb.state.initiative.clone();
    tactical.turn_idx = tb.turn_idx();
    tactical.turn_state = tb.turn_state;
    tactical.tie_priority_side = side_row(tb.state.tie_priority());
    tactical.pending_pad_ms = tb.pending_pad_ms;
    tactical.attack_damage_dealt_a = tb.state.attack_damage_dealt[0];
    tactical.attack_damage_dealt_b = tb.state.attack_damage_dealt[1];
    if tactical != tactical_before {
        ctx.db
            .battle_tactical()
            .battle_id()
            .update(tactical.clone());
    }
    let secret = BattleSecret {
        battle_id,
        seed: tb.state.seed,
        action_seq: tb.state.action_seq,
    };
    if ctx.db.battle_secret().battle_id().find(battle_id) != Some(secret.clone()) {
        ctx.db.battle_secret().battle_id().update(secret);
    }
    // READY rows: upsert the plans, drop the rest; an unchanged plan keeps its stamp.
    let existing: Vec<BattleQueue> = ctx
        .db
        .battle_queue()
        .battle_id()
        .filter(battle_id)
        .collect();
    for plan in &tb.plans {
        let owner = written
            .iter()
            .find(|u| u.unit_id == plan.unit)
            .and_then(|u| u.owner);
        let Some(owner) = owner else {
            continue;
        };
        match existing.iter().find(|q| q.unit_id == plan.unit) {
            Some(q) if q.entries == plan.entries => {}
            Some(q) => {
                ctx.db.battle_queue().unit_id().update(BattleQueue {
                    entries: plan.entries.clone(),
                    submitted_at_ms: now_ms,
                    ..q.clone()
                });
            }
            None => {
                ctx.db.battle_queue().insert(BattleQueue {
                    unit_id: plan.unit,
                    battle_id,
                    owner,
                    entries: plan.entries.clone(),
                    submitted_at_ms: now_ms,
                });
            }
        }
    }
    for q in &existing {
        if !tb.plans.iter().any(|p| p.unit == q.unit_id) {
            ctx.db.battle_queue().unit_id().delete(q.unit_id);
        }
    }
    // Every clock row the battle holds — one per side under the PvP ruleset; a wild side never
    // runs one — each written only when it moved.
    let clock_rows: Vec<BattleClock> = ctx
        .db
        .battle_clock()
        .battle_id()
        .filter(battle_id)
        .collect();
    for row in clock_rows {
        let c = tb.clocks[side_index(side_of_row(row.side))];
        let before = row.clone();
        let next = BattleClock {
            window_seq: c.window_seq,
            window_open_ms: c.window_open_ms,
            deadline_ms: c.deadline_ms,
            windows_this_unit_turn: c.windows_this_unit_turn,
            idle_ms_total: c.idle_ms_total,
            autopass_count: c.autopass_count,
            ..row
        };
        if next != before {
            ctx.db.battle_clock().clock_id().update(next);
        }
    }
    // The transcript.
    let mut seq = next_event_seq(ctx, battle_id);
    for payload in &out.events {
        ctx.db.battle_event().insert(BattleEvent {
            event_id: 0,
            battle_id,
            seq,
            round: out.round,
            payload: payload.clone(),
        });
        seq = seq.saturating_add(1);
    }
    // The summary's per-step delta (bt-9): a zero delta writes nothing.
    let player_units: Vec<u32> = written
        .iter()
        .filter(|u| is_player_owned(tb.state.kind, side_of_row(u.side)))
        .map(|u| u.unit_id)
        .collect();
    let step_prev = StepPrev {
        waiting: match prev.turn {
            TurnState::Waiting(unit) => Some(unit),
            TurnState::NotActive | TurnState::Advancing => None,
        },
        windows: prev.windows,
        full_hp: prev.full_hp.clone(),
    };
    let delta = tactics_settle::step_delta(&step_prev, out, &player_units);
    tactics_settle::accumulate(ctx, &anchor, &tactical, &delta);
    if finished {
        finish(
            ctx,
            Some(anchor),
            tactical,
            Close::Settled { state: &tb.state },
            now_ms,
            except,
        );
        return;
    }
    if let (TurnState::Waiting(unit), Some(window)) = (tb.turn_state, out.window) {
        arm_deadline(ctx, battle_id, unit, window.seq, window.deadline_ms);
    }
    let crossed = prev.turn != TurnState::Advancing || tb.state.round != prev.round;
    if tb.turn_state == TurnState::Advancing && crossed {
        if let Some(pin) = tb.advance_pin() {
            arm_advance(ctx, pin, now_ms);
        }
    }
}

/// THE terminal funnel, idempotent against the stored ROW (a caller's stale Active copy must
/// not settle twice). For a `Settled` close it persists damaged HP (the anchor already mirrors
/// the units): a wild battle through `write_back_party_hp`, a PvP-ruleset battle through the PvP
/// decisive-commit funnel `pvp::settle_pvp_battle` (both sides' HP, the anchor update, the rating
/// — bt-14); it writes the anchor's outcome, closes the tactical row, drops READY and staging
/// rows, disarms every schedule row but `except`, runs the one settlement
/// (`tactics_settle::settle`, per the `Close` kind) and arms the 24 h GC. `hp_ok` gates the
/// settlement's rewards and penalty (no rewards on a failed write-back, either side).
fn finish(
    ctx: &ReducerContext,
    anchor: Option<Battle>,
    mut tactical: BattleTactical,
    close: Close<'_>,
    now_ms: i64,
    except: Except,
) {
    let battle_id = tactical.battle_id;
    let stored_finished = ctx
        .db
        .battle_tactical()
        .battle_id()
        .find(battle_id)
        .is_some_and(|t| t.phase == Phase::Finished);
    if tactical.phase == Phase::Finished || stored_finished {
        return;
    }
    let was_active = tactical.phase == Phase::Active;
    let mut hp_ok = false;
    if let Some(anchor) = &anchor {
        match close {
            // A PvP-ruleset finish (bt-14, BT14.5) commits through THE PvP decisive-commit
            // funnel: both sides' HP, the anchor update, the rating (its only caller), the legacy
            // sweep; `hp_ok` is the funnel's word on both write-backs (the wild rule carried: no
            // rewards and no penalty on a failed write-back).
            Close::Settled { .. } if tactical.kind.uses_pvp_rules() => {
                // The funnel reports the write-backs as `Ok(both_ok)` and keeps the `Result`
                // shape for its 1v1 callers; an `Err` is not produced today.
                match crate::pvp::settle_pvp_battle(ctx, anchor.clone(), SideAWriteBack::HpOnly) {
                    Ok(ok) => hp_ok = ok,
                    Err(e) => {
                        let escaped = json_escape(&e);
                        mr_log(
                            "tactical_writeback_err",
                            &format!("\"battle_id\":{battle_id},\"reason\":\"{escaped}\""),
                        );
                    }
                }
            }
            Close::Settled { .. } => {
                match write_back_party_hp(ctx, anchor) {
                    Ok(()) => hp_ok = true,
                    Err(e) => {
                        let escaped = json_escape(&e);
                        mr_log(
                            "tactical_writeback_err",
                            &format!("\"battle_id\":{battle_id},\"reason\":\"{escaped}\""),
                        );
                    }
                }
                ctx.db.battle().battle_id().update(anchor.clone());
            }
            Close::Deploying | Close::LegacyEnded | Close::Fallback => {
                ctx.db.battle().battle_id().update(anchor.clone());
            }
        }
    }
    tactical.phase = Phase::Finished;
    tactical.turn_state = TurnState::NotActive;
    tactical.turn_idx = 0;
    ctx.db
        .battle_tactical()
        .battle_id()
        .update(tactical.clone());
    ctx.db.battle_queue().battle_id().delete(battle_id);
    ctx.db.battle_deploy().battle_id().delete(battle_id);
    disarm_deadlines(ctx, battle_id, except.deadline());
    disarm_advances(ctx, battle_id, except.advance());
    match &anchor {
        Some(anchor) => {
            tactics_settle::settle(ctx, anchor, &tactical, &close, hp_ok, was_active, now_ms);
        }
        None => {
            mr_log(
                "tactical_settle_skipped",
                &format!("\"battle_id\":{battle_id},\"reason\":\"no anchor\""),
            );
            tactics_settle::finalize_orphan_summary(ctx, &tactical, was_active);
        }
    }
    arm_gc(ctx, battle_id, now_ms.saturating_add(GC_DELAY_MS));
}

/// Close a battle as `Fled` with NO HP write: a Deploying battle (design §3.3, §3.7), an
/// Active tactical row whose anchor a legacy reducer already ended (its own write-back ran;
/// writing the units' older HP would heal or revive — security audit MED-1), or the fallback of
/// an unloadable battle. `close` says which, so the settlement knows what still applies.
fn close_without_hp(
    ctx: &ReducerContext,
    tactical: BattleTactical,
    now_ms: i64,
    except: Except,
    close: Close<'_>,
) {
    let anchor = ctx
        .db
        .battle()
        .battle_id()
        .find(tactical.battle_id)
        .map(|mut a| {
            if a.state.outcome == BattleOutcome::Ongoing {
                a.state.outcome = BattleOutcome::Fled;
            }
            a
        });
    finish(ctx, anchor, tactical, close, now_ms, except);
}

/// The never-fail close of a battle that cannot be loaded (content drift, a missing row):
/// every deployed party unit's HP (both sides) goes straight to its monster row, the anchor becomes `Fled`
/// (never deleted), the tactical side closes and the GC is armed. Logged once.
fn fallback_close(
    ctx: &ReducerContext,
    tactical: BattleTactical,
    reason: &str,
    now_ms: i64,
    except: Except,
) {
    let battle_id = tactical.battle_id;
    let escaped = json_escape(reason);
    mr_log(
        "tactical_fallback_close",
        &format!(
            "\"battle_id\":{battle_id},\"tactical_phase\":\"{:?}\",\"reason\":\"{escaped}\"",
            tactical.phase
        ),
    );
    if tactical.phase == Phase::Deploying {
        // Nothing was legitimately deployed: a unit row here is a reveal that failed mid-way
        // (the scheduled path commits what it wrote) and must not stay readable for 24 h.
        ctx.db.battle_unit().battle_id().delete(battle_id);
    }
    if tactical.phase == Phase::Active {
        let units: Vec<BattleUnit> = ctx.db.battle_unit().battle_id().filter(battle_id).collect();
        for unit in units {
            let Some(mid) = unit.monster_id else {
                continue;
            };
            let Some(mut m) = ctx.db.monster().monster_id().find(mid) else {
                continue;
            };
            if Some(m.owner_identity) != unit.owner {
                // Traded away since the unit row was written: never write HP into
                // another player's monster (the `write_back_party_hp` contract).
                mr_log(
                    "tactical_fallback_owner_mismatch",
                    &format!("\"battle_id\":{battle_id},\"monster_id\":{mid}"),
                );
                continue;
            }
            m.current_hp = unit.cur_hp.min(m.stat_hp);
            if let Err(e) = update_monster_synced(ctx, m) {
                let escaped = json_escape(&e);
                mr_log(
                    "tactical_writeback_err",
                    &format!("\"battle_id\":{battle_id},\"reason\":\"{escaped}\""),
                );
            }
        }
    }
    close_without_hp(ctx, tactical, now_ms, except, Close::Fallback);
}

// ===========================================================================
// Hooks — the executor's seam, implemented over rows and game-core rules.
// ===========================================================================

/// What the planner and the recruit glue need of a wild unit: its stance and spawn (bt-8),
/// its species, level and `battle_wild_unit` seed (bt-9) — read before the executor runs, so
/// the hooks never query mid-step.
#[derive(Clone, Copy)]
struct WildRef {
    unit_id: u32,
    stance: Stance,
    spawn: Cell,
    species_id: u32,
    level: u8,
    /// `battle_wild_unit.individuality_seed` (`None` when the row is gone).
    seed: Option<u32>,
}

struct ShellHooks<'a> {
    ctx: &'a ReducerContext,
    battle_id: u64,
    content: &'static TacticsContent,
    /// `(unit_id, owner)` for every unit row (a wild has no owner).
    owners: Vec<(u32, Option<Identity>)>,
    /// Every wild unit.
    wilds: Vec<WildRef>,
    /// A recruit resolved in this transaction already (the battle's first attempt sets
    /// `weaken_first`; the row's own count advances only when the step stores).
    recruit_seen: bool,
}

/// The hooks over one battle's unit rows (a free fn: the gate census refuses an
/// impl-block signature that names the reducer context).
fn shell_hooks<'a>(
    ctx: &'a ReducerContext,
    battle_id: u64,
    units: &[BattleUnit],
    map: &BattleMapDef,
    content: &'static TacticsContent,
) -> ShellHooks<'a> {
    let owners = units.iter().map(|u| (u.unit_id, u.owner)).collect();
    let seeds: Vec<(u8, u32)> = ctx
        .db
        .battle_wild_unit()
        .battle_id()
        .filter(battle_id)
        .map(|w| (w.wild_index, w.individuality_seed))
        .collect();
    let wilds = units
        .iter()
        .filter_map(|u| {
            let stance = u.stance?;
            let wild_index = u.wild_index?;
            let spawn = map.spawn_b.get(usize::from(wild_index)).copied()?;
            Some(WildRef {
                unit_id: u.unit_id,
                stance: stance_of_row(stance),
                spawn,
                species_id: u.species_id,
                level: u.level,
                seed: seeds
                    .iter()
                    .find(|(i, _)| *i == wild_index)
                    .map(|(_, seed)| *seed),
            })
        })
        .collect();
    ShellHooks {
        ctx,
        battle_id,
        content,
        owners,
        wilds,
        recruit_seen: false,
    }
}

/// Everything a recruit success needs of its target, resolved BEFORE the executor debits the
/// bait (R-21r-a-CONTENTLOAD): the wild's row facts, its seed row, its content species and level.
struct Recruitable {
    species: &'static Species,
    species_id: u32,
    level: Level,
    seed: u32,
}

impl ShellHooks<'_> {
    fn owner_of(&self, unit: u32) -> Option<Identity> {
        self.owners
            .iter()
            .find(|(id, _)| *id == unit)
            .and_then(|(_, owner)| *owner)
    }

    /// The target as a recruitable wild, or why it is not (`TargetGone`: no row facts, no seed
    /// row, no content species, no legal level — the entry halts, nothing is debited).
    fn recruitable(&self, target: u32) -> Result<Recruitable, HaltReason> {
        let gone = HaltReason::TargetGone { id: target };
        let wild = self
            .wilds
            .iter()
            .find(|w| w.unit_id == target)
            .ok_or(gone)?;
        let seed = wild.seed.ok_or(gone)?;
        let species = self.content.species(wild.species_id).map_err(|_| gone)?;
        let level = Level::new(wild.level).map_err(|_| gone)?;
        Ok(Recruitable {
            species,
            species_id: wild.species_id,
            level,
            seed,
        })
    }

    /// The bait's bonus (‰) from content, or `ItemNotHeld` for an id that is not a bait at all
    /// (an unknown item, or one with no recruit function): judged before any debit.
    fn bait_bonus(&self, bait: Option<u32>) -> Result<u16, HaltReason> {
        match bait {
            None => Ok(0),
            Some(item_id) => self
                .content
                .bait_bonus(item_id)
                .ok_or(HaltReason::ItemNotHeld { item_id }),
        }
    }
}

/// `recruit_preflight`'s refusal as a halt reason: a bait outside the carried rule's domain reads
/// as not held; a recruiter or target that is gone reads as the target gone.
fn halt_of_recruit(error: RecruitError, bait: Option<u32>) -> HaltReason {
    match error {
        RecruitError::BaitBonus { .. } => HaltReason::ItemNotHeld {
            item_id: bait.unwrap_or(0),
        },
        RecruitError::UnknownUnit { id } | RecruitError::TargetGone { id } => {
            HaltReason::TargetGone { id }
        }
    }
}

impl Hooks for ShellHooks<'_> {
    fn item_count(&self, unit: u32, item_id: u32) -> u32 {
        let Some(owner) = self.owner_of(unit) else {
            return 0;
        };
        let held: u32 = self
            .ctx
            .db
            .inventory()
            .owner_identity()
            .filter(owner)
            .filter(|r| r.item_id == item_id)
            .map(|r| r.count)
            .fold(0u32, u32::saturating_add);
        let escrowed = escrowed_item_qty(
            self.ctx
                .db
                .trade_offer()
                .initiator()
                .filter(owner)
                .chain(self.ctx.db.trade_offer().counterparty().filter(owner)),
            owner,
            item_id,
        );
        held.saturating_sub(escrowed)
    }

    fn take_item(&mut self, unit: u32, item_id: u32) -> bool {
        let Some(owner) = self.owner_of(unit) else {
            return false;
        };
        consume_one(self.ctx, owner, item_id).is_ok()
    }

    fn recruit_headroom(&self, unit: u32) -> bool {
        self.owner_of(unit).is_some()
    }

    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction> {
        match self.wilds.iter().find(|w| w.unit_id == unit) {
            Some(w) => ai::plan(state, unit, w.stance, w.spawn, &self.content.tuning),
            None => vec![QueuedAction::EndTurn],
        }
    }

    fn validate_delegated(
        &self,
        state: &TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Result<(), HaltReason> {
        match validated {
            // The item rule (range, Ally filter, cure match) has no game-core home yet
            // (R-bt-8-ITEMRULE): refused at pop as at submit.
            Validated::Item { .. } => Err(HaltReason::NotAllowed(ActionKind::Item)),
            Validated::Recruit { target, bait, .. } => {
                let bait_bonus = self.bait_bonus(*bait)?;
                self.recruitable(*target)?;
                recruit_preflight(state, unit, *target, bait_bonus)
                    .map_err(|e| halt_of_recruit(e, *bait))
            }
            Validated::Flee { .. }
            | Validated::Move { .. }
            | Validated::Skill { .. }
            | Validated::EndTurn => Ok(()),
        }
    }

    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Vec<EventPayload> {
        let Validated::Recruit { target, bait, .. } = validated else {
            // A flee's bookkeeping is the shell's finish path (HP persists through the anchor,
            // the ledger pays at the finish); items never reach here (refused above).
            return Vec::new();
        };
        let battle_id = self.battle_id;
        // Everything below was validated before the debit; a miss here is an invariant fault.
        let (Some(owner), Ok(bait_bonus), Ok(wild)) = (
            self.owner_of(unit),
            self.bait_bonus(*bait),
            self.recruitable(*target),
        ) else {
            mr_log(
                "tactical_recruit_resolve_err",
                &format!("\"battle_id\":{battle_id},\"unit\":{unit},\"target\":{target}"),
            );
            return Vec::new();
        };
        // The H1 proxy reads the PRE-roll HP.
        let hp = state
            .unit(*target)
            .map_or(0, |w| hp_permille(w.cur_hp, w.max_hp()));
        let ev = match resolve_recruit(state, unit, *target, bait_bonus) {
            Ok(ev) => ev,
            Err(e) => {
                let escaped = json_escape(&format!("{e:?}"));
                mr_log(
                    "tactical_recruit_resolve_err",
                    &format!("\"battle_id\":{battle_id},\"unit\":{unit},\"reason\":\"{escaped}\""),
                );
                return Vec::new();
            }
        };
        record_recruit_event(
            self.ctx,
            owner,
            battle_id,
            wild.species_id,
            hp,
            *bait,
            ev.success,
        );
        if !self.recruit_seen {
            self.recruit_seen = true;
            mark_first_recruit(self.ctx, battle_id, hp);
        }
        if ev.success {
            let inserted = insert_recruited(self.ctx, owner, wild.seed, wild.species, wild.level);
            // Public coordinates only — never the seed or the genes (side-channel).
            log::info!(
                "{{\"evt\":\"tactical_recruit_success\",\"battle_id\":{battle_id},\"species_id\":{},\"monster_id\":{}}}",
                wild.species_id,
                inserted.monster_id
            );
        }
        vec![EventPayload::RecruitResult(ev)]
    }
}

// ===========================================================================
// Formation + deployment
// ===========================================================================

/// The remembered formation resolved against the live party (design §3.3): distinct
/// remembered ids that are in the party AND conscious, in remembered order, then filled
/// from party order with conscious members not already chosen, up to `cap`.
fn resolve_formation(remembered: &[u64], party_in_order: &[(u64, bool)], cap: usize) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    for &id in remembered {
        if out.len() >= cap {
            break;
        }
        if out.contains(&id) {
            continue;
        }
        if party_in_order
            .iter()
            .any(|&(m, conscious)| m == id && conscious)
        {
            out.push(id);
        }
    }
    for &(m, conscious) in party_in_order {
        if out.len() >= cap {
            break;
        }
        if conscious && !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

/// Side B of a materialisation: the wild pack (`battle_wild_unit`) or the opponent's picks.
#[derive(Clone, Copy)]
enum SideB<'a> {
    Wild,
    Picks(&'a [DeployPick]),
}

/// One side's picks validated against its owner's live rows — the monster exists, is `owner`'s,
/// is in the side's party list, is conscious, its slot is a spawn of that side, it is not in an
/// open trade — each with its monster row and kit. Nothing is written.
fn stage_side(
    ctx: &ReducerContext,
    content: &'static TacticsContent,
    spawns: usize,
    owner: Identity,
    party: &[u64],
    picks: &[DeployPick],
) -> Result<Vec<(Monster, DeployPick, UnitKit)>, String> {
    let mut staged = Vec::with_capacity(picks.len());
    for pick in picks {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(pick.monster_id)
            .ok_or_else(|| format!("monster {} not owned by player", pick.monster_id))?;
        if m.owner_identity != owner {
            return Err(format!("monster {} not owned by player", pick.monster_id));
        }
        if !party.contains(&pick.monster_id) {
            return Err(format!("monster {} not in party", pick.monster_id));
        }
        if m.current_hp == 0 {
            return Err(format!("monster {} is fainted", pick.monster_id));
        }
        if usize::from(pick.slot) >= spawns {
            return Err(format!("slot {} out of range", pick.slot));
        }
        reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(owner)
                .chain(ctx.db.trade_offer().counterparty().filter(owner)),
            pick.monster_id,
        )?;
        let kit = content.unit_kit(m.species_id, m.level, monster_stats(&m))?;
        staged.push((m, *pick, kit));
    }
    Ok(staged)
}

/// Insert one deployed party monster as a `battle_unit` row of `side` at `pos` (full budget state
/// is the engine's at `deploy_unit`; the row mirrors it).
#[allow(clippy::too_many_arguments)]
fn insert_party_unit(
    ctx: &ReducerContext,
    battle_id: u64,
    side: SideRow,
    owner: Identity,
    m: &Monster,
    pick: DeployPick,
    kit: &UnitKit,
    pos: Cell,
) -> BattleUnit {
    ctx.db.battle_unit().insert(BattleUnit {
        unit_id: 0,
        battle_id,
        side,
        owner: Some(owner),
        slot: pick.slot,
        monster_id: Some(m.monster_id),
        wild_index: None,
        species_id: m.species_id,
        level: m.level,
        affinity: kit.affinity,
        x: pos.x,
        y: pos.y,
        cur_hp: m.current_hp,
        stats: kit.stats,
        skill_ids: kit.skills.iter().map(|s| s.skill_id).collect(),
        status: None,
        ap: 0,
        strides_used: 0,
        attacks: 0,
        budget_last: None,
        guard: false,
        first_stand: true,
        movement: class_row(kit.class),
        stride: stride_for_base_speed(kit.base_speed),
        stance: None,
        state: UnitState::Active,
    })
}

/// Remember `owner`'s confirmed deploy (design §3.3: the formation follows every confirmed deploy).
fn remember_formation(ctx: &ReducerContext, owner: Identity, monster_ids: Vec<u64>) {
    if ctx
        .db
        .player_formation()
        .owner_identity()
        .find(owner)
        .is_some()
    {
        ctx.db
            .player_formation()
            .owner_identity()
            .update(PlayerFormation {
                owner_identity: owner,
                monster_ids,
            });
    } else {
        ctx.db.player_formation().insert(PlayerFormation {
            owner_identity: owner,
            monster_ids,
        });
    }
}

/// Materialise side A's picks and side B (the wild pack, or the opponent's picks — bt-14's
/// reveal-by-copy, both sides in ONE transaction) into `battle_unit` rows, build the rules state
/// and run the battle's first step. Every fallible check runs BEFORE the first write (a dry run
/// with placeholder ids); the calls after the writes repeat validated inputs and cannot refuse.
/// The Deploying deadline rows go BEFORE the start so the first real window's row survives;
/// `except` spares a deploy row that is firing right now (the runtime deletes it itself).
fn materialize(
    ctx: &ReducerContext,
    anchor: Battle,
    tactical: BattleTactical,
    picks_a: &[DeployPick],
    side_b: SideB<'_>,
    now_ms: i64,
    except: Except,
) -> Result<(), String> {
    let battle_id = anchor.battle_id;
    let content = content()?;
    let map = content.map(tactical.map_id)?;
    let secret = ctx
        .db
        .battle_secret()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| format!("battle {battle_id} has no secret row"))?;
    // Validate every pick before the first write.
    let staged = stage_side(
        ctx,
        content,
        map.spawn_a.len(),
        anchor.player_identity,
        &anchor.party_monster_ids,
        picks_a,
    )?;
    let staged_b = match side_b {
        SideB::Picks(picks) => stage_side(
            ctx,
            content,
            map.spawn_b.len(),
            anchor.opponent_identity,
            &anchor.opponent_monster_ids,
            picks,
        )?,
        SideB::Wild => Vec::new(),
    };
    let mut wild_rows: Vec<BattleWildUnit> = match side_b {
        SideB::Wild => ctx
            .db
            .battle_wild_unit()
            .battle_id()
            .filter(battle_id)
            .collect(),
        SideB::Picks(_) => Vec::new(),
    };
    wild_rows.sort_by_key(|w| w.wild_index);
    let mut wild_staged = Vec::with_capacity(wild_rows.len());
    for w in &wild_rows {
        let species = content.species(w.species_id)?;
        let level = Level::new(w.level)?;
        let inst = build_monster(w.individuality_seed, species, level);
        let kit = content.unit_kit(w.species_id, w.level, inst.derived_stats)?;
        let stance = content.kit(w.species_id)?.stance;
        let pos = map
            .spawn_b
            .get(usize::from(w.wild_index))
            .copied()
            .ok_or_else(|| {
                format!(
                    "map {} has no spawn for wild {}",
                    tactical.map_id, w.wild_index
                )
            })?;
        wild_staged.push((w, kit, stance, pos));
    }
    // Dry run with placeholder ids: every per-unit and set check (`deploy_unit`,
    // `TacticalState::new`) runs BEFORE the first write, so a refusal leaves the store
    // untouched (the native host has no rollback).
    let mut dry: Vec<TacticalUnit> = Vec::new();
    let placeholder = |n: usize| u32::MAX.saturating_sub(u32::try_from(n).unwrap_or(u32::MAX));
    for (i, (m, pick, kit)) in staged.iter().enumerate() {
        let pos = map.spawn_a[usize::from(pick.slot)];
        dry.push(
            deploy_unit(
                placeholder(i),
                Side::A,
                pick.slot,
                pos,
                kit.clone(),
                m.current_hp,
            )
            .map_err(|e| format!("deploy: {e:?}"))?,
        );
    }
    for (j, (m, pick, kit)) in staged_b.iter().enumerate() {
        let pos = map.spawn_b[usize::from(pick.slot)];
        dry.push(
            deploy_unit(
                placeholder(staged.len() + j),
                Side::B,
                pick.slot,
                pos,
                kit.clone(),
                m.current_hp,
            )
            .map_err(|e| format!("deploy: {e:?}"))?,
        );
    }
    for (j, (w, kit, _, pos)) in wild_staged.iter().enumerate() {
        dry.push(
            deploy_unit(
                placeholder(staged.len() + staged_b.len() + j),
                Side::B,
                w.wild_index,
                *pos,
                kit.clone(),
                kit.stats.hp,
            )
            .map_err(|e| format!("deploy: {e:?}"))?,
        );
    }
    TacticalState::new(tactical.kind, secret.seed, map, dry)
        .map_err(|e| format!("deploy: {e:?}"))?;
    // Writes: units (ids come from the insert), then the rules state.
    let mut units: Vec<TacticalUnit> = Vec::new();
    let mut rows: Vec<BattleUnit> = Vec::new();
    for (m, pick, kit) in &staged {
        let pos = map.spawn_a[usize::from(pick.slot)];
        let row = insert_party_unit(
            ctx,
            battle_id,
            SideRow::A,
            anchor.player_identity,
            m,
            *pick,
            kit,
            pos,
        );
        units.push(
            deploy_unit(
                row.unit_id,
                Side::A,
                pick.slot,
                pos,
                kit.clone(),
                m.current_hp,
            )
            .map_err(|e| format!("deploy: {e:?}"))?,
        );
        rows.push(row);
    }
    for (m, pick, kit) in &staged_b {
        let pos = map.spawn_b[usize::from(pick.slot)];
        let row = insert_party_unit(
            ctx,
            battle_id,
            SideRow::B,
            anchor.opponent_identity,
            m,
            *pick,
            kit,
            pos,
        );
        units.push(
            deploy_unit(
                row.unit_id,
                Side::B,
                pick.slot,
                pos,
                kit.clone(),
                m.current_hp,
            )
            .map_err(|e| format!("deploy: {e:?}"))?,
        );
        rows.push(row);
    }
    for (w, kit, stance, pos) in wild_staged {
        let cur_hp = kit.stats.hp;
        let row = ctx.db.battle_unit().insert(BattleUnit {
            unit_id: 0,
            battle_id,
            side: SideRow::B,
            owner: None,
            slot: w.wild_index,
            monster_id: None,
            wild_index: Some(w.wild_index),
            species_id: w.species_id,
            level: w.level,
            affinity: kit.affinity,
            x: pos.x,
            y: pos.y,
            cur_hp,
            stats: kit.stats,
            skill_ids: kit.skills.iter().map(|s| s.skill_id).collect(),
            status: None,
            ap: 0,
            strides_used: 0,
            attacks: 0,
            budget_last: None,
            guard: false,
            first_stand: true,
            movement: class_row(kit.class),
            stride: stride_for_base_speed(kit.base_speed),
            stance: Some(stance_row(stance)),
            state: UnitState::Active,
        });
        units.push(
            deploy_unit(row.unit_id, Side::B, w.wild_index, pos, kit, cur_hp)
                .map_err(|e| format!("deploy: {e:?}"))?,
        );
        rows.push(row);
    }
    let state = TacticalState::new(tactical.kind, secret.seed, map, units)
        .map_err(|e| format!("deploy: {e:?}"))?;
    let mut tb = TacticalBattle::new(battle_id, state);
    // The remembered formation follows every confirmed deploy (design §3.3) — each picking owner's;
    // in Practice (one owner on both sides) side A's picks are what is remembered.
    remember_formation(
        ctx,
        anchor.player_identity,
        staged.iter().map(|(m, _, _)| m.monster_id).collect(),
    );
    if !staged_b.is_empty() && anchor.opponent_identity != anchor.player_identity {
        remember_formation(
            ctx,
            anchor.opponent_identity,
            staged_b.iter().map(|(m, _, _)| m.monster_id).collect(),
        );
    }
    ctx.db.battle_deploy().battle_id().delete(battle_id);
    // The Deploying window's row goes before the start arms the first real window (the firing
    // row, if this IS the deploy expiry, is the runtime's to delete).
    let deploy_rows: Vec<u64> = ctx
        .db
        .tactical_deadline_sched()
        .battle_id()
        .filter(battle_id)
        .filter(|r| r.unit_id == DEPLOY_WINDOW_UNIT)
        .map(|r| r.scheduled_id)
        .filter(|id| Some(*id) != except.deadline())
        .collect();
    for id in deploy_rows {
        ctx.db.tactical_deadline_sched().scheduled_id().delete(id);
    }
    let rules = content.rules();
    let prev = prev_of(&tb);
    let mut hooks = shell_hooks(ctx, battle_id, &rows, map, content);
    let out = tb
        .start(now_ms, &rules, &mut hooks)
        .map_err(|e| format!("start: {e:?}"))?;
    drop(hooks);
    let mut tactical = tactical;
    tactical.phase = Phase::Active;
    store(
        ctx,
        Loaded {
            anchor,
            tactical,
            units: rows,
            map,
            tb,
        },
        &out,
        prev,
        now_ms,
        except,
    );
    Ok(())
}

// ===========================================================================
// Battle start (the only writer of a new tactical battle)
// ===========================================================================

/// The legacy anchor's view of one party monster (marshaling, no rule).
fn anchor_monster(m: &Monster, species: &Species) -> BattleMonster {
    BattleMonster {
        species_id: m.species_id,
        affinity: species.affinity,
        level: m.level,
        current_hp: m.current_hp,
        max_hp: m.stat_hp,
        stats: monster_stats(m),
        known_skill_ids: species.learnable_skill_ids.clone(),
        status: None,
    }
}

/// Start a wild tactical battle for `player` from `encounter_seed` (design §3.4): the
/// anchor `battle` row (Ongoing, the whole party as side A), `battle_tactical`,
/// `battle_secret`, one `battle_wild_unit` per wild and the side-A clock; a pack of 1
/// auto-deploys the remembered formation and starts at once, a pack ≥ 2 opens the
/// Deploying window (the tuning's `pve_deploy_ms`). `forced_pack` overrides the roll (dev only; `1..=MAX_PACK`
/// and never more than the conscious party — reject, never clamp).
///
/// Until bt-16 wires the grass path, the only production caller is the cfg-gated dev
/// reducer, so the default build is told the function (and what only it reaches) is live.
#[cfg_attr(not(feature = "dev_reducers"), allow(dead_code))]
pub(crate) fn start_wild_tactical(
    ctx: &ReducerContext,
    player: Identity,
    encounter_seed: u64,
    forced_pack: Option<u8>,
) -> Result<u64, String> {
    require_subject_not_deleting(ctx, player)?;
    let Some((party_ids, lead_level)) = lead_party(ctx, player) else {
        return Err("no party monster".to_string());
    };
    check_party_size(party_ids.len())?;
    for (i, mid) in party_ids.iter().enumerate() {
        if party_ids[..i].contains(mid) {
            return Err(format!("duplicate monster_id {mid} in party"));
        }
    }
    if is_in_ongoing_battle(ctx, player) {
        return Err("already in an ongoing battle".to_string());
    }
    let zone_id = ctx
        .db
        .player()
        .identity()
        .find(player)
        .and_then(|p| ctx.db.character().entity_id().find(p.entity_id))
        .map(|c| c.zone_id)
        .ok_or_else(|| "no character".to_string())?;
    let content = content()?;
    let zone = content.zone(zone_id)?;
    let table = content.encounter(zone_id)?;
    let mut party: Vec<Monster> = Vec::with_capacity(party_ids.len());
    for &mid in &party_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("party monster {mid} not found"))?;
        if m.owner_identity != player {
            return Err(format!("monster {mid} not owned by player"));
        }
        reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(player)
                .chain(ctx.db.trade_offer().counterparty().filter(player)),
            mid,
        )?;
        party.push(m);
    }
    let conscious =
        u8::try_from(party.iter().filter(|m| m.current_hp > 0).count()).unwrap_or(u8::MAX);
    if conscious == 0 {
        return Err("party has no conscious monster".to_string());
    }
    let encounter = generate_encounter(
        &zone.pack_weights,
        zone.battle_map_pool.len(),
        encounter_seed,
        conscious,
    )
    .map_err(|e| format!("encounter: {e:?}"))?;
    let pack = match forced_pack {
        None => u8::try_from(encounter.seeds.len()).unwrap_or(MAX_PACK),
        Some(n) if n == 0 || n > MAX_PACK => return Err("pack must be 1..=3".to_string()),
        Some(n) if n > conscious => {
            return Err(format!(
                "pack {n} exceeds the conscious party ({conscious})"
            ))
        }
        Some(n) => n,
    };
    let map_id = *zone
        .battle_map_pool
        .get(encounter.map_index)
        .ok_or_else(|| "encounter: map index out of pool".to_string())?;
    let map = content.map(map_id)?;
    if map.spawn_b.len() < usize::from(pack) {
        return Err(format!(
            "map {map_id} has {} wild spawns, pack {pack}",
            map.spawn_b.len()
        ));
    }
    // One wild per slot: the grass trigger already happened upstream, so the spawn roll
    // runs with the trigger made total; species and level come from the zone's bands.
    let always = EncounterTable {
        encounter_rate: 1000,
        ..table.clone()
    };
    let mut wilds: Vec<(u8, u32, u8, u32)> = Vec::with_capacity(usize::from(pack));
    for i in 0..pack {
        let seed = wild_seed(encounter_seed, i);
        // The spawn roll runs on a DERIVED seed: `resolve_encounter` and `roll_individuality`
        // share one splitmix32 mixer, so rolling species/level from the individuality seed
        // itself would tie the level band to the wild's IVs (verifier F6).
        let spawn_seed =
            u32::try_from(splitmix64(u64::from(seed) ^ SPAWN_ROLL_SALT) >> 32).unwrap_or(u32::MAX);
        let spawn = resolve_encounter(&always, spawn_seed, lead_level)
            .ok_or_else(|| "no encounter triggered".to_string())?;
        content.species(spawn.species_id)?;
        content.kit(spawn.species_id)?;
        wilds.push((i, spawn.species_id, spawn.level.as_u8(), seed));
    }
    // The legacy anchor: the whole party as side A, EVERY wild of the pack as side B in
    // `wild_index` order (bt-12 B, BT12.2: the client's deploy confirm lists the pack from the
    // anchor's side B, which it already ingests). Every wild is conscious at the start, so
    // `with_lead` seats wild 0 as the lead.
    let mut team_a = Vec::with_capacity(party.len());
    for m in &party {
        team_a.push(anchor_monster(m, content.species(m.species_id)?));
    }
    let side_a = BattleSide::with_lead(team_a)
        .ok_or_else(|| "party has no conscious monster".to_string())?;
    let mut team_b = Vec::with_capacity(wilds.len());
    for &(_, species_id, level, seed) in &wilds {
        team_b.push(wild_anchor_monster(content, species_id, level, seed)?);
    }
    let side_b = BattleSide::with_lead(team_b)
        .ok_or_else(|| "wild opponent has no conscious monster".to_string())?;
    let now = now_ms(ctx);
    // A pack >= 2 waits in Deploying: its deadline is written ONCE, to the side-A clock (the
    // client's "Still there?" countdown reads it) AND the deploy window row (R6: one instant).
    let deploy_deadline = if pack == 1 {
        None
    } else {
        Some(deploy_deadline_ms(now, &content.tuning))
    };
    let anchor = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: player,
        opponent_identity: WILD_IDENTITY,
        state: BattleState {
            side_a,
            side_b,
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        },
        party_monster_ids: party_ids.clone(),
        opponent_monster_ids: vec![],
        created_at_ms: now,
    });
    let battle_id = anchor.battle_id;
    let tactical = ctx.db.battle_tactical().insert(BattleTactical {
        battle_id,
        kind: BattleKind::Wild,
        format: WILD_FORMAT,
        map_id,
        content_version: CONTENT_VERSION,
        phase: if pack == 1 {
            Phase::Active
        } else {
            Phase::Deploying
        },
        round: 1,
        initiative: Vec::new(),
        turn_idx: 0,
        turn_state: TurnState::NotActive,
        tie_priority_side: SideRow::A,
        pending_pad_ms: 0,
        attack_damage_dealt_a: 0,
        attack_damage_dealt_b: 0,
    });
    ctx.db.battle_secret().insert(BattleSecret {
        battle_id,
        seed: splitmix64(encounter_seed ^ BATTLE_SEED_SALT),
        action_seq: 0,
    });
    for (i, species_id, level, seed) in &wilds {
        ctx.db.battle_wild_unit().insert(BattleWildUnit {
            wild_unit_id: 0,
            battle_id,
            wild_index: *i,
            species_id: *species_id,
            level: *level,
            individuality_seed: *seed,
        });
    }
    ctx.db.battle_clock().insert(BattleClock {
        clock_id: 0,
        battle_id,
        side: SideRow::A,
        player,
        window_seq: 0,
        window_open_ms: None,
        deadline_ms: deploy_deadline,
        windows_this_unit_turn: 0,
        idle_ms_total: 0,
        autopass_count: 0,
    });
    log::info!(
        "{{\"evt\":\"tactical_wild_start\",\"battle_id\":{battle_id},\"map_id\":{map_id},\"pack\":{pack}}}"
    );
    if pack == 1 {
        let remembered: Vec<u64> = ctx
            .db
            .player_formation()
            .owner_identity()
            .find(player)
            .map(|f| f.monster_ids)
            .unwrap_or_default();
        let party_in_order: Vec<(u64, bool)> = party
            .iter()
            .map(|m| (m.monster_id, m.current_hp > 0))
            .collect();
        let cap = usize::from(MAX_PACK).min(map.spawn_a.len());
        let picks: Vec<DeployPick> = resolve_formation(&remembered, &party_in_order, cap)
            .into_iter()
            .enumerate()
            .map(|(slot, monster_id)| DeployPick {
                monster_id,
                slot: u8::try_from(slot).unwrap_or(u8::MAX),
            })
            .collect();
        materialize(
            ctx,
            anchor,
            tactical,
            &picks,
            SideB::Wild,
            now,
            Except::None,
        )?;
    } else if let Some(deadline) = deploy_deadline {
        arm_deadline(ctx, battle_id, DEPLOY_WINDOW_UNIT, 0, deadline);
    }
    Ok(battle_id)
}

/// One wild of the pack as the anchor's side B seats it: built from its individuality seed at the
/// band level (full HP, the derived stats, the species' learnable skills, no status) — exactly the
/// `battle_wild_unit` rebuild `materialize` performs, so the anchor and the units agree.
fn wild_anchor_monster(
    content: &TacticsContent,
    species_id: u32,
    level: u8,
    seed: u32,
) -> Result<BattleMonster, String> {
    let species = content.species(species_id)?;
    let built = build_monster(seed, species, Level::new(level)?);
    Ok(BattleMonster {
        species_id,
        affinity: species.affinity,
        level,
        current_hp: built.derived_stats.hp,
        max_hp: built.derived_stats.hp,
        stats: built.derived_stats,
        known_skill_ids: species.learnable_skill_ids.clone(),
        status: None,
    })
}

/// The PvP map for `seed` (bt-14, BT14.2): the `pvp: true` maps in content order, index
/// `splitmix64(seed ^ PVP_MAP_SALT) % n`; `None` when content has no PvP map. Pure.
pub(crate) fn pvp_map_id(maps: &[BattleMapEntry], seed: u64) -> Option<u32> {
    let pool: Vec<u32> = maps.iter().filter(|m| m.pvp).map(|m| m.id).collect();
    let n = u64::try_from(pool.len()).ok().filter(|&n| n > 0)?;
    let idx = usize::try_from(splitmix64(seed ^ PVP_MAP_SALT) % n).ok()?;
    pool.get(idx).copied()
}

/// How many monsters one side of a PvP battle deploys (bt-14, BT14.1): exactly `format`, or all
/// it has if fewer conscious. Pure.
pub(crate) fn pvp_deploy_count(format: u8, conscious: usize) -> usize {
    usize::from(format).min(conscious)
}

/// One side's party of a PvP battle, validated against the live rows: every id exists, is
/// `owner`'s, is party-slotted and is not in an open trade. Nothing is written.
fn load_side_party(
    ctx: &ReducerContext,
    owner: Identity,
    ids: &[u64],
) -> Result<Vec<Monster>, String> {
    let mut party = Vec::with_capacity(ids.len());
    for &mid in ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("monster {mid} not found"))?;
        if m.owner_identity != owner {
            return Err(format!("monster {mid} not owned by caller"));
        }
        check_monster_in_party(m.party_slot).map_err(|e| format!("monster {mid} {e}"))?;
        reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(owner)
                .chain(ctx.db.trade_offer().counterparty().filter(owner)),
            mid,
        )?;
        party.push(m);
    }
    Ok(party)
}

/// Start a PvP (or Practice, when `challenger == opponent`) tactical battle (bt-14, BT14.2): the
/// anchor `battle` row (Ongoing, both parties), `battle_tactical` (Deploying), `battle_secret`,
/// one `battle_clock` row per side (both on the deploy deadline) and one owner-only
/// `battle_deploy` staging row per side (empty, unlocked), plus the 45 s deploy window row.
/// Nothing is written before the last guard (reject, never clamp). The two side lists must be
/// DISJOINT (Practice splits one party): every per-side rule then works over its own list.
/// Reached only through the cfg-gated `dev_start_tactical_pvp` until bt-16 flips the
/// challenge-accept path; EVERY caller must draw `seed` from `ctx.random()` — the public `map_id`
/// derives from it.
#[cfg_attr(not(feature = "dev_reducers"), allow(dead_code))]
pub(crate) fn start_pvp_tactical(
    ctx: &ReducerContext,
    challenger: Identity,
    challenger_party: &[u64],
    opponent: Identity,
    opponent_party: &[u64],
    format: u8,
    seed: u64,
) -> Result<u64, String> {
    if format == 0 || format > PVP_FORMAT_MAX {
        return Err("format must be 1..=3".to_string());
    }
    require_subject_not_deleting(ctx, challenger)?;
    require_subject_not_deleting(ctx, opponent)?;
    check_party_size(challenger_party.len())?;
    check_party_size(opponent_party.len())?;
    for party in [challenger_party, opponent_party] {
        for (i, mid) in party.iter().enumerate() {
            if party[..i].contains(mid) {
                return Err(format!("duplicate monster_id {mid} in party"));
            }
        }
    }
    if challenger_party.iter().any(|m| opponent_party.contains(m)) {
        return Err("a monster cannot be on both sides".to_string());
    }
    if is_in_ongoing_battle(ctx, challenger) {
        return Err("already in an ongoing battle".to_string());
    }
    if challenger != opponent && is_in_ongoing_battle(ctx, opponent) {
        return Err("opponent is already in an ongoing battle".to_string());
    }
    let content = content()?;
    let party_a = load_side_party(ctx, challenger, challenger_party)?;
    let party_b = load_side_party(ctx, opponent, opponent_party)?;
    if !party_a.iter().any(|m| m.current_hp > 0) {
        return Err("challenger party has no conscious monster".to_string());
    }
    if !party_b.iter().any(|m| m.current_hp > 0) {
        return Err("opponent party has no conscious monster".to_string());
    }
    let map_id =
        pvp_map_id(content.maps, seed).ok_or_else(|| "no PvP map in content".to_string())?;
    let kind = if challenger == opponent {
        BattleKind::Practice
    } else {
        BattleKind::Pvp
    };
    let mut team_a = Vec::with_capacity(party_a.len());
    for m in &party_a {
        team_a.push(anchor_monster(m, content.species(m.species_id)?));
    }
    let mut team_b = Vec::with_capacity(party_b.len());
    for m in &party_b {
        team_b.push(anchor_monster(m, content.species(m.species_id)?));
    }
    // Both sides hold a conscious monster (checked above), so both leads seat.
    let side_a = BattleSide::with_lead(team_a)
        .ok_or_else(|| "challenger party has no conscious monster".to_string())?;
    let side_b = BattleSide::with_lead(team_b)
        .ok_or_else(|| "opponent party has no conscious monster".to_string())?;
    let now = now_ms(ctx);
    let deploy_deadline = now.saturating_add(i64::from(
        game_core::tactics::clock::deploy_budget_ms(kind, &content.tuning),
    ));
    let anchor = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: challenger,
        opponent_identity: opponent,
        state: BattleState {
            side_a,
            side_b,
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        },
        party_monster_ids: challenger_party.to_vec(),
        opponent_monster_ids: opponent_party.to_vec(),
        created_at_ms: now,
    });
    let battle_id = anchor.battle_id;
    ctx.db.battle_tactical().insert(BattleTactical {
        battle_id,
        kind,
        format,
        map_id,
        content_version: CONTENT_VERSION,
        phase: Phase::Deploying,
        round: 1,
        initiative: Vec::new(),
        turn_idx: 0,
        turn_state: TurnState::NotActive,
        tie_priority_side: SideRow::A,
        pending_pad_ms: 0,
        attack_damage_dealt_a: 0,
        attack_damage_dealt_b: 0,
    });
    ctx.db.battle_secret().insert(BattleSecret {
        battle_id,
        seed: splitmix64(seed ^ BATTLE_SEED_SALT),
        action_seq: 0,
    });
    for (side, player) in [(SideRow::A, challenger), (SideRow::B, opponent)] {
        // Both clocks carry the deploy deadline (the client's countdown source, bt-12 B) and no
        // open window; the first turn window opens at the reveal.
        ctx.db.battle_clock().insert(BattleClock {
            clock_id: 0,
            battle_id,
            side,
            player,
            window_seq: 0,
            window_open_ms: None,
            deadline_ms: Some(deploy_deadline),
            windows_this_unit_turn: 0,
            idle_ms_total: 0,
            autopass_count: 0,
        });
        ctx.db.battle_deploy().insert(BattleDeploy {
            deploy_id: 0,
            battle_id,
            owner: player,
            side,
            picks: Vec::new(),
            locked: false,
        });
    }
    arm_deadline(ctx, battle_id, DEPLOY_WINDOW_UNIT, 0, deploy_deadline);
    log::info!(
        "{{\"evt\":\"tactical_pvp_start\",\"battle_id\":{battle_id},\"map_id\":{map_id},\"format\":{format},\"kind\":\"{kind:?}\"}}"
    );
    Ok(battle_id)
}

/// The Deploying window's deadline (bt-12 B, BT12.2): `now` plus game-core's deploy budget for a
/// wild battle (`clock::deploy_budget_ms`: the tuning's `pve_deploy_ms`) — the ONE instant both the
/// deploy-deadline schedule row and the side-A clock's `deadline_ms` carry, so the client's "Still
/// there?" countdown reads the same deadline in Deploying as in a turn window.
pub(crate) fn deploy_deadline_ms(now_ms: i64, tuning: &TacticsTuning) -> i64 {
    now_ms.saturating_add(i64::from(game_core::tactics::clock::deploy_budget_ms(
        BattleKind::Wild,
        tuning,
    )))
}

// ===========================================================================
// Client reducers
// ===========================================================================

/// The anchor + participant preamble every client reducer shares, BEFORE any tactical row is
/// read (no phase or kit detail reaches a non-participant). A participant is the anchor's player
/// or its real opponent (bt-14); a stranger is "not owner". The deletion gate follows it at
/// depth 0 in each reducer body (the gate census reads that level).
fn participant_anchor(
    ctx: &ReducerContext,
    reducer: &str,
    battle_id: u64,
) -> Result<Battle, String> {
    let me = ctx.sender();
    let Some(anchor) = ctx.db.battle().battle_id().find(battle_id) else {
        let e = "battle not found".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    if side_of_sender(&anchor, me).is_none() {
        let e = "not owner".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    Ok(anchor)
}

fn reject(reducer: &str, sender: Identity, reason: String) -> Result<(), String> {
    log_reject(reducer, sender, &reason);
    Err(reason)
}

/// The sender's side of the anchor (A for the player; B for a real opponent; A when the
/// anchor is a practice battle naming one identity twice).
fn side_of_sender(anchor: &Battle, sender: Identity) -> Option<Side> {
    if anchor.player_identity == sender {
        Some(Side::A)
    } else if anchor.opponent_identity == sender && anchor.opponent_identity != WILD_IDENTITY {
        Some(Side::B)
    } else {
        None
    }
}

/// The side a sender acts for on `unit`: its anchor side, except in a Practice battle (one
/// identity on both sides), where it is the unit row's own side when the sender owns the unit.
fn sender_side(anchor: &Battle, sender: Identity, unit: Option<&BattleUnit>) -> Option<Side> {
    if anchor.player_identity == sender && anchor.opponent_identity == sender {
        return unit
            .filter(|u| u.owner == Some(sender))
            .map(|u| side_of_row(u.side));
    }
    side_of_sender(anchor, sender)
}

/// The forfeiting side's opponent wins — the carried 1v1 mapping (`game_core::pvp_forfeit_outcome`),
/// never restated.
fn opponent_wins(forfeiter: Side) -> BattleOutcome {
    pvp_forfeit_outcome(match forfeiter {
        Side::A => SideId::SideA,
        Side::B => SideId::SideB,
    })
}

fn active_tactical(
    ctx: &ReducerContext,
    reducer: &str,
    anchor: &Battle,
) -> Result<BattleTactical, String> {
    let me = ctx.sender();
    if anchor.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(anchor.battle_id) else {
        let e = "not a tactical battle".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    if tactical.phase != Phase::Active {
        let e = "battle is not active".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    Ok(tactical)
}

/// Confirm the deploy of a Deploying wild battle: the picks (the owner's conscious party
/// monsters bound to distinct spawn slots) become `battle_unit` rows at once.
#[spacetimedb::reducer]
pub fn deploy_units(
    ctx: &ReducerContext,
    battle_id: u64,
    picks: Vec<DeployPick>,
) -> Result<(), String> {
    const NAME: &str = "deploy_units";
    let me = ctx.sender();
    let anchor = participant_anchor(ctx, NAME, battle_id)?;
    crate::guards::require_commitment_predates_deletion(ctx, NAME, anchor.created_at_ms)?;
    if anchor.state.outcome != BattleOutcome::Ongoing {
        return reject(NAME, me, "battle is not ongoing".to_string());
    }
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return reject(NAME, me, "not a tactical battle".to_string());
    };
    if tactical.phase != Phase::Deploying {
        return reject(NAME, me, "battle is not deploying".to_string());
    }
    let content = match content() {
        Ok(c) => c,
        Err(e) => return reject(NAME, me, e),
    };
    let map = match content.map(tactical.map_id) {
        Ok(m) => m,
        Err(e) => return reject(NAME, me, e),
    };
    if picks.is_empty() {
        return reject(NAME, me, "no picks".to_string());
    }
    if tactical.kind.uses_pvp_rules() {
        return stage_pvp(ctx, me, &anchor, &tactical, map, &picks)
            .inspect_err(|e| log_reject(NAME, me, e));
    }
    if picks.len() > usize::from(MAX_PACK).min(map.spawn_a.len()) {
        return reject(NAME, me, "too many picks".to_string());
    }
    for (i, pick) in picks.iter().enumerate() {
        if picks[..i].iter().any(|p| p.monster_id == pick.monster_id) {
            return reject(
                NAME,
                me,
                format!("duplicate monster_id {}", pick.monster_id),
            );
        }
        if picks[..i].iter().any(|p| p.slot == pick.slot) {
            return reject(NAME, me, format!("duplicate slot {}", pick.slot));
        }
        if usize::from(pick.slot) >= map.spawn_a.len() {
            return reject(NAME, me, format!("slot {} out of range", pick.slot));
        }
        let Some(m) = ctx.db.monster().monster_id().find(pick.monster_id) else {
            return reject(
                NAME,
                me,
                format!("monster {} not owned by player", pick.monster_id),
            );
        };
        if m.owner_identity != me {
            return reject(
                NAME,
                me,
                format!("monster {} not owned by player", pick.monster_id),
            );
        }
        if !anchor.party_monster_ids.contains(&pick.monster_id) {
            return reject(
                NAME,
                me,
                format!("monster {} not in party", pick.monster_id),
            );
        }
        if m.current_hp == 0 {
            return reject(NAME, me, format!("monster {} is fainted", pick.monster_id));
        }
        if let Err(e) = reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(me)
                .chain(ctx.db.trade_offer().counterparty().filter(me)),
            pick.monster_id,
        ) {
            return reject(NAME, me, e);
        }
    }
    materialize(
        ctx,
        anchor,
        tactical,
        &picks,
        SideB::Wild,
        now_ms(ctx),
        Except::None,
    )
    .inspect_err(|e| log_reject(NAME, me, e))
}

/// The PvP secret deploy (bt-14, BT14.2; design §3.3): the sender's picks go to ITS owner-only
/// `battle_deploy` row, locked — exactly `pvp_deploy_count(format, its conscious members)` of
/// them (BT14.1), each owned, in its side's party list, conscious, not in trade, on a spawn of
/// its side (reject, never clamp). In Practice the one owner stages side A, then side B (the two
/// lists are disjoint, so a monster belongs to exactly one side). When BOTH rows are locked this
/// call copies both stagings into `battle_unit` rows and starts the battle: the reveal-by-copy.
/// Otherwise nothing participant-visible is written, and no refusal text depends on the
/// opponent's row.
fn stage_pvp(
    ctx: &ReducerContext,
    me: Identity,
    anchor: &Battle,
    tactical: &BattleTactical,
    map: &BattleMapDef,
    picks: &[DeployPick],
) -> Result<(), String> {
    let mut rows: Vec<BattleDeploy> = ctx
        .db
        .battle_deploy()
        .battle_id()
        .filter(anchor.battle_id)
        .collect();
    rows.sort_by_key(|d| d.side as u8);
    let practice = anchor.player_identity == anchor.opponent_identity;
    let mine = if practice {
        rows.iter().find(|d| !d.locked)
    } else {
        rows.iter().find(|d| d.owner == me)
    };
    let Some(mine) = mine else {
        return Err("already locked".to_string());
    };
    if mine.locked {
        return Err("already locked".to_string());
    }
    let side = side_of_row(mine.side);
    // The side's OWN list only. The two lists are disjoint by construction (`start_pvp_tactical`),
    // so nothing here ever reads the other side's staging: a pick naming the opponent's monster
    // fails `stage_side`'s ownership check with the same text whether or not it is locked — the
    // refusal must never be an oracle on the opponent's row.
    let (party, spawns) = match side {
        Side::A => (&anchor.party_monster_ids, map.spawn_a.len()),
        Side::B => (&anchor.opponent_monster_ids, map.spawn_b.len()),
    };
    // Trades are not a reduction: a monster in an open trade never enters a party list
    // (`start_pvp_tactical` refuses it), and the Ongoing anchor blocks new trades for both owners.
    let conscious = party
        .iter()
        .filter(|&&mid| {
            ctx.db
                .monster()
                .monster_id()
                .find(mid)
                .is_some_and(|m| m.owner_identity == me && m.current_hp > 0)
        })
        .count();
    let need = pvp_deploy_count(tactical.format, conscious);
    if picks.len() != need {
        return Err(format!("deploy exactly {need} monsters"));
    }
    for (i, pick) in picks.iter().enumerate() {
        if picks[..i].iter().any(|p| p.monster_id == pick.monster_id) {
            return Err(format!("duplicate monster_id {}", pick.monster_id));
        }
        if picks[..i].iter().any(|p| p.slot == pick.slot) {
            return Err(format!("duplicate slot {}", pick.slot));
        }
    }
    let content = content()?;
    stage_side(ctx, content, spawns, me, party, picks)?;
    ctx.db.battle_deploy().deploy_id().update(BattleDeploy {
        picks: picks.to_vec(),
        locked: true,
        ..mine.clone()
    });
    // The reveal: once the other row is locked too (this row's lock is the update above).
    let other = rows.iter().find(|d| d.deploy_id != mine.deploy_id);
    let Some(other) = other.filter(|d| d.locked) else {
        return Ok(());
    };
    let (picks_a, picks_b) = match side {
        Side::A => (picks.to_vec(), other.picks.clone()),
        Side::B => (other.picks.clone(), picks.to_vec()),
    };
    // A refusal here concerns the OTHER side's rows (this side was just validated) or the board
    // as a set: the detail is logged, never returned to this caller.
    materialize(
        ctx,
        anchor.clone(),
        tactical.clone(),
        &picks_a,
        SideB::Picks(&picks_b),
        now_ms(ctx),
        Except::None,
    )
    .map_err(|e| {
        let escaped = json_escape(&e);
        mr_log(
            "tactical_pvp_reveal_err",
            &format!(
                "\"battle_id\":{},\"reason\":\"{escaped}\"",
                anchor.battle_id
            ),
        );
        "deploy failed".to_string()
    })
}

/// Submit a plan for one of the sender's units: a pre-queue (stored READY) or, for the
/// waiting unit, a live submit that executes at once (design §2.3).
#[spacetimedb::reducer]
pub fn submit_queue(
    ctx: &ReducerContext,
    battle_id: u64,
    unit_id: u32,
    entries: Vec<QueuedAction>,
) -> Result<(), String> {
    const NAME: &str = "submit_queue";
    let me = ctx.sender();
    let anchor = participant_anchor(ctx, NAME, battle_id)?;
    crate::guards::require_commitment_predates_deletion(ctx, NAME, anchor.created_at_ms)?;
    if entries.len() > MAX_STORED_ENTRIES {
        return reject(NAME, me, "too many entries".to_string());
    }
    if entries.iter().any(|e| matches!(e, QueuedAction::Item(_))) {
        return reject(NAME, me, format!("{NAME}: {ITEMS_NOT_AVAILABLE}"));
    }
    active_tactical(ctx, NAME, &anchor)?;
    let loaded = match load(ctx, battle_id) {
        Ok(l) => l,
        Err(e) => return reject(NAME, me, e),
    };
    if loaded.tb.state.unit(unit_id).is_none() {
        return reject(NAME, me, format!("unit {unit_id} not in battle"));
    }
    let unit_row = loaded.units.iter().find(|u| u.unit_id == unit_id);
    let Some(side) = sender_side(&anchor, me, unit_row) else {
        return reject(NAME, me, "not owner".to_string());
    };
    let content = match content() {
        Ok(c) => c,
        Err(e) => return reject(NAME, me, e),
    };
    let Loaded {
        anchor,
        tactical,
        units,
        map,
        mut tb,
    } = loaded;
    let now = now_ms(ctx);
    let prev = prev_of(&tb);
    let prev_clock = tb.clocks[side_index(side)];
    let rules = content.rules();
    let mut hooks = shell_hooks(ctx, battle_id, &units, map, content);
    let out = match tb.submit_queue(now, side, unit_id, entries, &rules, &mut hooks) {
        Ok(out) => out,
        Err(e) => return reject(NAME, me, format!("{NAME}: {e:?}")),
    };
    drop(hooks);
    if tb.clocks[side_index(side)] != prev_clock {
        // The waiting window closed: its row goes; `store` arms the next one if any.
        disarm_deadlines(ctx, battle_id, None);
    }
    store(
        ctx,
        Loaded {
            anchor,
            tactical,
            units,
            map,
            tb,
        },
        &out,
        prev,
        now,
        Except::None,
    );
    Ok(())
}

/// Delete the sender's READY row for `unit_id` (design §2.3 cancel race: a row consumed
/// at TurnStart answers `AlreadyActing`).
#[spacetimedb::reducer]
pub fn cancel_queue(ctx: &ReducerContext, battle_id: u64, unit_id: u32) -> Result<(), String> {
    const NAME: &str = "cancel_queue";
    let me = ctx.sender();
    let anchor = participant_anchor(ctx, NAME, battle_id)?;
    crate::guards::require_commitment_predates_deletion(ctx, NAME, anchor.created_at_ms)?;
    active_tactical(ctx, NAME, &anchor)?;
    let mut loaded = match load(ctx, battle_id) {
        Ok(l) => l,
        Err(e) => return reject(NAME, me, e),
    };
    if loaded.tb.state.unit(unit_id).is_none() {
        return reject(NAME, me, format!("unit {unit_id} not in battle"));
    }
    let unit_row = loaded.units.iter().find(|u| u.unit_id == unit_id);
    let Some(side) = sender_side(&anchor, me, unit_row) else {
        return reject(NAME, me, "not owner".to_string());
    };
    let prev = prev_of(&loaded.tb);
    if let Err(e) = loaded.tb.cancel_queue(side, unit_id) {
        return reject(NAME, me, format!("{NAME}: {e:?}"));
    }
    store(
        ctx,
        loaded,
        &StepResult::default(),
        prev,
        now_ms(ctx),
        Except::None,
    );
    Ok(())
}

/// Forfeit the sender's PvP tactical battle (bt-14, BT14.5; design §6.4): a client-confirmed
/// reducer, not a queue entry, 0 AP — the opponent wins through the one terminal funnel
/// (`conclude(.., EndHow::Forfeit)` → `store` → `finish` → `pvp::settle_pvp_battle`). READY rows
/// are voided, never executed. A wild battle has Flee instead ("not a PvP battle"); a Deploying
/// battle is not forfeitable ("battle is not active": nothing is revealed yet and the 45 s window
/// ends it); in Practice the one owner forfeits side A.
#[spacetimedb::reducer]
pub fn forfeit(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    const NAME: &str = "forfeit";
    let me = ctx.sender();
    let anchor = participant_anchor(ctx, NAME, battle_id)?;
    crate::guards::require_commitment_predates_deletion(ctx, NAME, anchor.created_at_ms)?;
    if anchor.state.outcome != BattleOutcome::Ongoing {
        return reject(NAME, me, "battle is not ongoing".to_string());
    }
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return reject(NAME, me, "not a tactical battle".to_string());
    };
    if !tactical.kind.uses_pvp_rules() {
        return reject(NAME, me, "not a PvP battle".to_string());
    }
    if tactical.phase != Phase::Active {
        return reject(NAME, me, "battle is not active".to_string());
    }
    let Some(side) = side_of_sender(&anchor, me) else {
        return reject(NAME, me, "not owner".to_string());
    };
    let loaded = match load(ctx, battle_id) {
        Ok(l) => l,
        Err(e) => return reject(NAME, me, e),
    };
    let Loaded {
        anchor,
        tactical,
        units,
        map,
        mut tb,
    } = loaded;
    let now = now_ms(ctx);
    let prev = prev_of(&tb);
    let out = match tb.conclude(opponent_wins(side), EndHow::Forfeit) {
        Ok(out) => out,
        Err(e) => return reject(NAME, me, format!("{NAME}: {e:?}")),
    };
    store(
        ctx,
        Loaded {
            anchor,
            tactical,
            units,
            map,
            tb,
        },
        &out,
        prev,
        now,
        Except::None,
    );
    Ok(())
}

/// The PvP deploy window expired (bt-14, BT14.2; design §3.3): every side that has not locked is
/// auto-filled from its own list — the remembered formation, else the first conscious monsters in
/// slot order — capped at the format; then ONE copy reveals both sides. A side with nothing to field cancels the battle (`Fled`, unrated).
/// Not a strike: no clock moves.
fn expire_pvp_deploy(ctx: &ReducerContext, tactical: BattleTactical, now_ms: i64, except: Except) {
    let battle_id = tactical.battle_id;
    let Some(anchor) = ctx.db.battle().battle_id().find(battle_id) else {
        close_without_hp(ctx, tactical, now_ms, except, Close::Deploying);
        return;
    };
    let mut rows: Vec<BattleDeploy> = ctx
        .db
        .battle_deploy()
        .battle_id()
        .filter(battle_id)
        .collect();
    rows.sort_by_key(|d| d.side as u8);
    let mut sides: [Vec<DeployPick>; 2] = [Vec::new(), Vec::new()];
    for side in [Side::A, Side::B] {
        let picks = match rows.iter().find(|d| side_of_row(d.side) == side) {
            Some(d) if d.locked => d.picks.clone(),
            _ => {
                let (owner, party) = match side {
                    Side::A => (anchor.player_identity, &anchor.party_monster_ids),
                    Side::B => (anchor.opponent_identity, &anchor.opponent_monster_ids),
                };
                // The side's own (disjoint) list: remembered formation first, then slot order.
                let party_in_order: Vec<(u64, bool)> = party
                    .iter()
                    .map(|&mid| {
                        let conscious = ctx
                            .db
                            .monster()
                            .monster_id()
                            .find(mid)
                            .is_some_and(|m| m.owner_identity == owner && m.current_hp > 0);
                        (mid, conscious)
                    })
                    .collect();
                let remembered: Vec<u64> = ctx
                    .db
                    .player_formation()
                    .owner_identity()
                    .find(owner)
                    .map(|f| f.monster_ids)
                    .unwrap_or_default();
                let chosen =
                    resolve_formation(&remembered, &party_in_order, usize::from(tactical.format));
                chosen
                    .into_iter()
                    .enumerate()
                    .map(|(slot, monster_id)| DeployPick {
                        monster_id,
                        slot: u8::try_from(slot).unwrap_or(u8::MAX),
                    })
                    .collect()
            }
        };
        if picks.is_empty() {
            close_without_hp(ctx, tactical, now_ms, except, Close::Deploying);
            return;
        }
        sides[side_index(side)] = picks;
    }
    let [picks_a, picks_b] = sides;
    if let Err(e) = materialize(
        ctx,
        anchor,
        tactical.clone(),
        &picks_a,
        SideB::Picks(&picks_b),
        now_ms,
        except,
    ) {
        fallback_close(ctx, tactical, &e, now_ms, except);
    }
}

/// DEV/TEST entrypoint for the build phase (the live challenge-accept path flips in bt-16):
/// starts a PvP tactical battle between `challenger` and `opponent` (the same identity twice is a
/// Practice battle) — the caller itself as challenger, or any pair when the caller is the module
/// owner (`spacetime call` runs as the publisher). Both parties are the players' party slots;
/// `format` defaults to the challenger's pick (`pvp::challenge_format`); the seed is drawn
/// server-side.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn dev_start_tactical_pvp(
    ctx: &ReducerContext,
    challenger: Identity,
    opponent: Identity,
    format: Option<u8>,
) -> Result<(), String> {
    use crate::schema::config;
    const NAME: &str = "dev_start_tactical_pvp";
    crate::guards::require_not_deleting(ctx, NAME)?;
    let me = ctx.sender();
    let owner = ctx
        .db
        .config()
        .id()
        .find(0)
        .map(|c| c.owner_identity)
        .unwrap_or(Identity::ZERO);
    // Consent: a player may start only a PRACTICE battle for itself; pairing two different
    // identities (a non-consenting opponent, a rated result) is the module owner's alone.
    let practice = challenger == opponent;
    if me != owner && !(me == challenger && practice) {
        return reject(NAME, me, "not owner".to_string());
    }
    let Some(mut party_a) = lead_party_ids(ctx, challenger) else {
        return reject(NAME, me, "no party monster".to_string());
    };
    let (party_a, party_b) = if practice {
        // One party split into two DISJOINT side lists, in slot order.
        if party_a.len() < 2 {
            return reject(NAME, me, "practice needs two party monsters".to_string());
        }
        let b = party_a.split_off(party_a.len().div_ceil(2));
        (party_a, b)
    } else {
        let Some(party_b) = lead_party_ids(ctx, opponent) else {
            return reject(NAME, me, "no party monster".to_string());
        };
        (party_a, party_b)
    };
    let format = format.unwrap_or_else(|| challenge_format(party_a.len()));
    let seed: u64 = ctx.random();
    start_pvp_tactical(ctx, challenger, &party_a, opponent, &party_b, format, seed)
        .map(|_| ())
        .inspect_err(|e| log_reject(NAME, me, e))
}

/// DEV/TEST entrypoint for the build phase (the live encounter path flips in bt-16):
/// starts a wild tactical battle for `player` — the caller itself, or any player when the
/// caller is the module owner (`spacetime call` runs as the publisher). The encounter seed
/// is drawn server-side; `pack` forces the pack size for deterministic e2e seeding.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn dev_start_tactical_wild(
    ctx: &ReducerContext,
    player: Identity,
    pack: Option<u8>,
) -> Result<(), String> {
    use crate::schema::config;
    const NAME: &str = "dev_start_tactical_wild";
    crate::guards::require_not_deleting(ctx, NAME)?;
    let me = ctx.sender();
    let owner = ctx
        .db
        .config()
        .id()
        .find(0)
        .map(|c| c.owner_identity)
        .unwrap_or(Identity::ZERO);
    if me != player && me != owner {
        return reject(NAME, me, "not owner".to_string());
    }
    let seed: u64 = ctx.random();
    start_wild_tactical(ctx, player, seed, pack)
        .map(|_| ())
        .inspect_err(|e| log_reject(NAME, me, e))
}

// ===========================================================================
// Scheduled reducers (scheduler-only; otherwise never fail)
// ===========================================================================

/// A clock window (or the Deploying window) expired. Stale or premature fires change
/// nothing (a premature one re-arms at the real deadline); an unloadable battle closes.
#[spacetimedb::reducer]
pub fn tactical_deadline_fire(
    ctx: &ReducerContext,
    args: TacticalDeadlineSched,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tactical_deadline_fire is scheduler-only".to_string());
    }
    let battle_id = args.battle_id;
    let except = Except::Deadline(args.scheduled_id);
    let now = now_ms(ctx);
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return Ok(());
    };
    match tactical.phase {
        Phase::Finished => return Ok(()),
        Phase::Deploying => {
            if args.unit_id != DEPLOY_WINDOW_UNIT {
                return Ok(());
            }
            if tactical.kind.uses_pvp_rules() {
                // A premature fire re-arms at the clock's deploy deadline (every clock row of the
                // battle carries it), as `NotDue` does for a turn window.
                let deadline = ctx
                    .db
                    .battle_clock()
                    .battle_id()
                    .filter(battle_id)
                    .find_map(|c| c.deadline_ms);
                if let Some(deadline) = deadline.filter(|&d| now < d) {
                    arm_deadline(ctx, battle_id, DEPLOY_WINDOW_UNIT, 0, deadline);
                    return Ok(());
                }
                expire_pvp_deploy(ctx, tactical, now, except);
            } else {
                close_without_hp(ctx, tactical, now, except, Close::Deploying);
            }
            return Ok(());
        }
        Phase::Active => {}
    }
    if args.unit_id == DEPLOY_WINDOW_UNIT {
        return Ok(());
    }
    let anchor_live = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .is_some_and(|a| a.state.outcome == BattleOutcome::Ongoing);
    if !anchor_live {
        close_without_hp(ctx, tactical, now, except, Close::LegacyEnded);
        return Ok(());
    }
    let loaded = match load(ctx, battle_id) {
        Ok(l) => l,
        Err(e) => {
            fallback_close(ctx, tactical, &e, now, except);
            return Ok(());
        }
    };
    let content = match content() {
        Ok(c) => c,
        Err(e) => {
            fallback_close(ctx, tactical, &e, now, except);
            return Ok(());
        }
    };
    let Loaded {
        anchor,
        tactical,
        units,
        map,
        mut tb,
    } = loaded;
    let prev = prev_of(&tb);
    let rules = content.rules();
    let mut hooks = shell_hooks(ctx, battle_id, &units, map, content);
    let out = match tb.expire(now, args.unit_id, args.window_seq, &rules, &mut hooks) {
        Ok(out) => out,
        Err(ExpireError::NotDue { deadline_ms }) => {
            arm_deadline(ctx, battle_id, args.unit_id, args.window_seq, deadline_ms);
            return Ok(());
        }
        Err(_) => return Ok(()),
    };
    drop(hooks);
    disarm_deadlines(ctx, battle_id, except.deadline());
    store(
        ctx,
        Loaded {
            anchor,
            tactical,
            units,
            map,
            tb,
        },
        &out,
        prev,
        now,
        except,
    );
    Ok(())
}

/// The zero-delay round-boundary continuation (design §2.2 chain rule).
#[spacetimedb::reducer]
pub fn tactical_advance(ctx: &ReducerContext, args: TacticalAdvanceSched) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tactical_advance is scheduler-only".to_string());
    }
    let battle_id = args.battle_id;
    let except = Except::Advance(args.scheduled_id);
    let now = now_ms(ctx);
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return Ok(());
    };
    if tactical.phase != Phase::Active {
        return Ok(());
    }
    let anchor_live = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .is_some_and(|a| a.state.outcome == BattleOutcome::Ongoing);
    if !anchor_live {
        close_without_hp(ctx, tactical, now, except, Close::LegacyEnded);
        return Ok(());
    }
    let loaded = match load(ctx, battle_id) {
        Ok(l) => l,
        Err(e) => {
            fallback_close(ctx, tactical, &e, now, except);
            return Ok(());
        }
    };
    let content = match content() {
        Ok(c) => c,
        Err(e) => {
            fallback_close(ctx, tactical, &e, now, except);
            return Ok(());
        }
    };
    let Loaded {
        anchor,
        tactical,
        units,
        map,
        mut tb,
    } = loaded;
    let prev = prev_of(&tb);
    let pin = AdvancePin {
        battle_id,
        round: args.round,
    };
    let rules = content.rules();
    let mut hooks = shell_hooks(ctx, battle_id, &units, map, content);
    let Ok(out) = tb.advance(now, pin, &rules, &mut hooks) else {
        return Ok(());
    };
    drop(hooks);
    store(
        ctx,
        Loaded {
            anchor,
            tactical,
            units,
            map,
            tb,
        },
        &out,
        prev,
        now,
        except,
    );
    Ok(())
}

/// The 24 h sweep (design §8.1): a finished battle's event, unit, queue, clock, secret,
/// wild-unit and staging rows go; `battle_tactical`, `battle_summary` and the anchor
/// survive — except an anchor-less tactical row, which has no reader left and goes too.
#[spacetimedb::reducer]
pub fn battle_gc(ctx: &ReducerContext, args: BattleGcSched) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("battle_gc is scheduler-only".to_string());
    }
    let battle_id = args.battle_id;
    let now = now_ms(ctx);
    if let ScheduleAt::Time(at) = args.scheduled_at {
        let due_ms = at.to_micros_since_unix_epoch().div_euclid(1_000);
        if due_ms > now {
            arm_gc(ctx, battle_id, due_ms);
            return Ok(());
        }
    }
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return Ok(());
    };
    let anchor = ctx.db.battle().battle_id().find(battle_id);
    let anchor_terminal = anchor
        .as_ref()
        .is_none_or(|a| a.state.outcome != BattleOutcome::Ongoing);
    if tactical.phase != Phase::Finished && !anchor_terminal {
        return Ok(());
    }
    sweep_tactical_rows(ctx, battle_id, Some(args.scheduled_id), anchor.is_none());
    log::info!("{{\"evt\":\"tactical_battle_gc\",\"battle_id\":{battle_id}}}");
    Ok(())
}

/// A prior terminal anchor goes with everything that hung off it (R-bt-8-TACTICALSWEEP): its
/// still-`Ongoing` summary is finalised first (the rows that would have done so are going), then
/// the anchor, then the tactical rows. The legacy 1v1 funnel and the tactical settlement both
/// sweep through here (`battle::sweep_prior_terminals`).
pub(crate) fn sweep_swept_anchor(ctx: &ReducerContext, anchor: &Battle) {
    tactics_settle::finalize_swept_summary(ctx, anchor);
    ctx.db.battle().battle_id().delete(anchor.battle_id);
    sweep_tactical_rows(ctx, anchor.battle_id, None, true);
}

/// Delete a battle's per-battle rows — the GC roster (event, unit, queue, clock, secret,
/// wild-unit, staging) and every schedule row but `keep_gc` (a firing GC row the runtime
/// deletes itself); `drop_tactical` takes the `battle_tactical` row too (an anchor-less or swept
/// battle has no reader left). `battle_summary` always survives (telemetry). Shared by `battle_gc`
/// and the prior-terminal sweep (`battle::sweep_prior_terminals`, R-bt-8-TACTICALSWEEP).
pub(crate) fn sweep_tactical_rows(
    ctx: &ReducerContext,
    battle_id: u64,
    keep_gc: Option<u64>,
    drop_tactical: bool,
) {
    ctx.db.battle_event().battle_id().delete(battle_id);
    ctx.db.battle_unit().battle_id().delete(battle_id);
    ctx.db.battle_queue().battle_id().delete(battle_id);
    ctx.db.battle_clock().battle_id().delete(battle_id);
    ctx.db.battle_secret().battle_id().delete(battle_id);
    ctx.db.battle_wild_unit().battle_id().delete(battle_id);
    ctx.db.battle_deploy().battle_id().delete(battle_id);
    disarm_deadlines(ctx, battle_id, None);
    disarm_advances(ctx, battle_id, None);
    disarm_gcs(ctx, battle_id, keep_gc);
    if drop_tactical {
        ctx.db.battle_tactical().battle_id().delete(battle_id);
    }
}

// ===========================================================================
// Disconnect / forced-terminal resolver
// ===========================================================================

/// Resolve every Ongoing TACTICAL battle of `identity`, either role (design §3.7 and §6.4
/// disconnect): an Active wild battle auto-flees — damaged HP persists, READY rows are discarded
/// unexecuted; an Active PvP or Practice battle is the leaver's forfeit (the opponent wins, rated
/// through `pvp::settle_pvp_battle`, READY rows deleted not executed); a Deploying battle closes as
/// `Fled` with nothing persisted and no rating change. The anchor stays (terminal), so the legacy
/// wild and PvP resolvers that run after this skip it. Runs FIRST in
/// `crate::resolve_all_live_interactions`.
pub(crate) fn resolve_tactical_on_disconnect(ctx: &ReducerContext, identity: Identity) {
    // Both roles, each id once (a Practice anchor names the identity twice).
    let mut ids: BTreeSet<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(identity)
        .filter(|b| b.state.outcome == BattleOutcome::Ongoing)
        .map(|b| b.battle_id)
        .collect();
    ids.extend(
        ctx.db
            .battle()
            .opponent_identity()
            .filter(identity)
            .filter(|b| {
                b.state.outcome == BattleOutcome::Ongoing && b.opponent_identity != WILD_IDENTITY
            })
            .map(|b| b.battle_id),
    );
    let now = now_ms(ctx);
    for battle_id in ids {
        // A 1v1 anchor (no tactical row) is the legacy resolvers' to end.
        let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
            continue;
        };
        match tactical.phase {
            Phase::Finished => continue,
            Phase::Deploying => {
                close_without_hp(ctx, tactical, now, Except::None, Close::Deploying);
                continue;
            }
            Phase::Active => {}
        }
        let loaded = match load(ctx, battle_id) {
            Ok(l) => l,
            Err(e) => {
                fallback_close(ctx, tactical, &e, now, Except::None);
                continue;
            }
        };
        let Loaded {
            anchor,
            tactical,
            units,
            map,
            mut tb,
        } = loaded;
        let prev = prev_of(&tb);
        // A wild battle auto-flees; under the PvP ruleset the leaver forfeits (design §6.4 — the
        // carried immediate `forfeit_on_disconnect`, keyed on the last session by the caller).
        let (outcome, how) = if tb.state.kind.uses_pvp_rules() {
            // The ids above were selected by this identity's role, so a side always resolves.
            let Some(side) = side_of_sender(&anchor, identity) else {
                fallback_close(
                    ctx,
                    tactical,
                    "leaver is not a participant",
                    now,
                    Except::None,
                );
                continue;
            };
            (opponent_wins(side), EndHow::Forfeit)
        } else {
            (BattleOutcome::Fled, EndHow::AutoFlee)
        };
        let out = match tb.conclude(outcome, how) {
            Ok(out) => out,
            Err(_) => {
                fallback_close(ctx, tactical, "conclude refused", now, Except::None);
                continue;
            }
        };
        store(
            ctx,
            Loaded {
                anchor,
                tactical,
                units,
                map,
                tb,
            },
            &out,
            prev,
            now,
            Except::None,
        );
    }
}

#[cfg(test)]
#[path = "tactics_tests.rs"]
pub(crate) mod tactics_tests;
