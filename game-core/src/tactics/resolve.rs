//! Resolution — the tactical battle MODEL and the design §2.4 damage pipeline.
//!
//! The model (`TacticalUnit`, `TacticalState`, the view types `UnitKit`/`SkillTactics`, the
//! storage enums `BattleKind`/`UnitState`, and `TacticalEvent`) is what every tactics rule reads
//! and writes; the server (bt-7/bt-8) stores it as rows and the client (bt-10+) renders the events.
//! `initiative`, `upkeep` and `outcome` import it from here.
//!
//! The pipeline is pinned, integer-floored at every step and byte-identical native/wasm:
//!
//! ```text
//! hit = accuracy_check(skill.accuracy, roll % 100)            carried; one roll per target; miss → Missed
//! d0  = calc_damage(attacker, defender, skill, chart, variance∈85..=100, weather = None)   carried
//! d1  = flank ? d0 × 5/4 : d0
//! d2  = guard ? d1 × 3/4 : d1
//! d3  = immune ? 0 : max(d2, 1)
//! First-Stand (attack damage only): first_stand ∧ d3 ≥ hp → hp = 1, flag cleared, StoodGround
//! ```
//!
//! `calc_damage` and `accuracy_check` are reused BY VALUE: the pipeline builds a `BattleMonster`
//! and a `SkillDef` from the view types and calls the carried functions — the rule is not copied.
//! Every AoE target draws its own accuracy and variance roll from
//! `splitmix64(seed ^ action_seq)`, `action_seq` advancing once per draw; the seed is server-only.

use serde::{Deserialize, Serialize};

use crate::combat::ability::StatusKind;
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{BattleOutcome, Effectiveness, StatusEffect};
use crate::monster::types::{Affinity, StatBlock};

use super::economy::{EconomyError, Tier, TurnBudget, TurnEndCause};
use super::geometry::{Board, Cell, GeometryError, Side, SkillGeometry};
use super::initiative::Contender;
use super::map::BattleMapDef;
use super::movement::{MoveClass, Terrain};
use super::outcome::BattleEndHow;
use super::tuning::{BattleKind, TacticsTuning};

/// The canonical splitmix64 output for state `x` (`crate::tick_seed(x, 0, 0)`):
/// `splitmix64(0) == 0xE220_A839_7B1D_CDAF`. Every tactics roll and coin is one of these.
#[must_use]
pub fn splitmix64(x: u64) -> u64 {
    let _ = x;
    todo!("bt-2 resolve: splitmix64")
}

/// Unit lifecycle (stored in `battle_unit.state`). Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum UnitState {
    Active,
    Fainted,
    Recruited,
}

/// The tactical view of one skill (bt-6 joins `SkillDef` with its `tactics_skills` sidecar).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillTactics {
    pub skill_id: u32,
    pub tier: Tier,
    pub affinity: Affinity,
    pub power: u16,
    pub accuracy: u8,
    pub applies_status: Option<StatusKind>,
    pub geometry: SkillGeometry,
}

/// The tactical view of one battler (species × level × individuality, already derived).
/// `max_hp` is `stats.hp`; stride derives from `base_speed` (never the levelled speed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitKit {
    pub species_id: u32,
    pub affinity: Affinity,
    pub level: u8,
    pub stats: StatBlock,
    pub base_speed: u16,
    pub class: MoveClass,
    pub skills: Vec<SkillTactics>,
}

/// One deployed unit — the design's `battle_unit` row minus ownership.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TacticalUnit {
    pub id: u32,
    pub side: Side,
    /// Deployment slot on its side (the comparator's last key).
    pub slot: u8,
    pub kit: UnitKit,
    pub pos: Cell,
    pub cur_hp: u16,
    pub status: Option<StatusEffect>,
    pub budget: TurnBudget,
    pub guard: bool,
    pub first_stand: bool,
    pub state: UnitState,
}

impl TacticalUnit {
    /// `kit.stats.hp`.
    #[must_use]
    pub fn max_hp(&self) -> u16 {
        todo!("bt-2 resolve: TacticalUnit::max_hp")
    }

    /// `state == Active && cur_hp > 0`.
    #[must_use]
    pub fn is_conscious(&self) -> bool {
        todo!("bt-2 resolve: TacticalUnit::is_conscious")
    }

    /// `movement::stride_for_base_speed(kit.base_speed)`.
    #[must_use]
    pub fn stride(&self) -> u8 {
        todo!("bt-2 resolve: TacticalUnit::stride")
    }
}

/// Why a unit (or a set of units) cannot be deployed — reject, never clamp. The per-unit checks
/// run in declaration order; the set checks (`DuplicateId`, `DuplicateSlot`, `BadPosition`,
/// `EmptySide`) run in `TacticalState::new` after every unit passed on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeployError {
    /// `cur_hp == 0`: fainted units never deploy (r2).
    Fainted { id: u32 },
    /// `cur_hp > kit.stats.hp`.
    HpAboveMax { id: u32, cur_hp: u16, max_hp: u16 },
    /// `kit.stats.defense == 0` (the carried `calc_damage` precondition).
    ZeroDefense { id: u32 },
    /// Two units share an id.
    DuplicateId { id: u32 },
    /// Two units share a `(side, slot)`.
    DuplicateSlot { side: Side, slot: u8 },
    /// A unit's tile is off the map or already held by another unit.
    BadPosition { id: u32 },
    /// A side has no unit.
    EmptySide { side: Side },
}

/// The ONE per-unit validation: `cur_hp ≥ 1`, `cur_hp ≤ max_hp`, `defense ≥ 1`.
///
/// # Errors
/// `Fainted`, `HpAboveMax`, `ZeroDefense` in that order.
pub fn validate_unit(unit: &TacticalUnit) -> Result<(), DeployError> {
    let _ = unit;
    todo!("bt-2 resolve: validate_unit")
}

/// Deploy a conscious unit: `first_stand = true`, `state = Active`, no Guard, no status, an idle
/// budget (its first TurnStart refreshes it). Runs [`validate_unit`].
///
/// # Errors
/// See [`validate_unit`].
pub fn deploy_unit(
    id: u32,
    side: Side,
    slot: u8,
    pos: Cell,
    kit: UnitKit,
    cur_hp: u16,
) -> Result<TacticalUnit, DeployError> {
    let _ = (id, side, slot, pos, kit, cur_hp);
    todo!("bt-2 resolve: deploy_unit")
}

/// The whole tactical battle as the rules see it (the server composes it from its rows).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TacticalState {
    pub kind: BattleKind,
    /// `battle_secret.seed` — server-only; never client-readable.
    pub seed: u64,
    /// `battle_secret.action_seq` — advances once per roll drawn.
    pub action_seq: u64,
    /// 1-based.
    pub round: u16,
    pub width: u8,
    pub height: u8,
    /// Row-major `y * width + x` (the validated map's tiles).
    pub terrain: Vec<Terrain>,
    pub units: Vec<TacticalUnit>,
    /// This round's frozen order (ids); KO and recruit removals are the only mid-round edits
    /// (always a subsequence of the list built at round start). bt-3 owns the turn cursor.
    pub initiative: Vec<u32>,
    /// Units holding a READY plan on the server (ids only; bt-3 owns the rows). A KO voids it
    /// with a visible `QueueVoided`.
    pub queued: Vec<u32>,
    /// Cumulative HP removed by attacks, per side (A = 0, B = 1) — adjudication element 3.
    pub attack_damage_dealt: [u32; 2],
    pub outcome: BattleOutcome,
}

impl TacticalState {
    /// A battle at round 1 on `map` with `units` deployed, `action_seq` 0, initiative built,
    /// `Ongoing`. Every unit passes [`validate_unit`], then the set checks (unique id, unique
    /// `(side, slot)`, in-bounds non-overlapping `pos`, a unit on each side); `units` is then
    /// canonicalised to `(side, slot)` order so every per-unit iteration is replay-stable.
    ///
    /// # Errors
    /// See [`DeployError`].
    pub fn new(
        kind: BattleKind,
        seed: u64,
        map: &BattleMapDef,
        units: Vec<TacticalUnit>,
    ) -> Result<Self, DeployError> {
        let _ = (kind, seed, map, units);
        todo!("bt-2 resolve: TacticalState::new")
    }

    /// The geometry/movement view: no LoS blockers in P1; `alive = is_conscious()`.
    #[must_use]
    pub fn board(&self) -> Board {
        todo!("bt-2 resolve: TacticalState::board")
    }

    #[must_use]
    pub fn unit(&self, id: u32) -> Option<&TacticalUnit> {
        let _ = id;
        todo!("bt-2 resolve: TacticalState::unit")
    }

    pub fn unit_mut(&mut self, id: u32) -> Option<&mut TacticalUnit> {
        let _ = id;
        todo!("bt-2 resolve: TacticalState::unit_mut")
    }

    /// `priority_for_round(round1_priority(kind, seed), round)`.
    #[must_use]
    pub fn tie_priority(&self) -> Side {
        todo!("bt-2 resolve: TacticalState::tie_priority")
    }

    /// The conscious units as comparator inputs.
    #[must_use]
    pub fn contenders(&self) -> Vec<Contender> {
        todo!("bt-2 resolve: TacticalState::contenders")
    }

    /// `initiative = order(contenders, tie_priority)`.
    pub fn rebuild_initiative(&mut self) {
        todo!("bt-2 resolve: TacticalState::rebuild_initiative")
    }

    /// Drop `id` from `initiative` and `queued` (the only mid-round edits; a recruit removal
    /// calls this too). Returns whether `id` was in the initiative.
    pub fn remove_from_initiative(&mut self, id: u32) -> bool {
        let _ = id;
        todo!("bt-2 resolve: TacticalState::remove_from_initiative")
    }
}

/// Why a unit may not act now (checked in declaration order after `BattleOver`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActError {
    BattleOver,
    UnknownUnit(u32),
    Recruited(u32),
    /// `state == Fainted` or `cur_hp == 0`: a 0-HP unit never acts (r2).
    Fainted(u32),
}

/// May `id` act: the battle is `Ongoing`, the unit exists, is not recruited and is conscious.
///
/// # Errors
/// See [`ActError`].
pub fn can_act(state: &TacticalState, id: u32) -> Result<(), ActError> {
    let _ = (state, id);
    todo!("bt-2 resolve: can_act")
}

/// TurnStart: a fresh budget, Guard off, First-Stand cleared (an auto-pass still activates).
///
/// # Errors
/// [`can_act`]'s.
pub fn turn_start(state: &mut TacticalState, id: u32, t: &TacticsTuning) -> Result<(), ActError> {
    let _ = (state, id, t);
    todo!("bt-2 resolve: turn_start")
}

/// TurnEnd: sets the unit's Guard per `economy::guard_granted` (read from its budget), then
/// resets the budget to idle (`TurnBudget::default()`) so nothing can be spent until its next
/// TurnStart. Returns whether Guard was granted.
///
/// # Errors
/// [`can_act`]'s.
pub fn turn_end(
    state: &mut TacticalState,
    id: u32,
    cause: TurnEndCause,
    t: &TacticsTuning,
) -> Result<bool, ActError> {
    let _ = (state, id, cause, t);
    todo!("bt-2 resolve: turn_end")
}

/// One target's outcome inside `Executed` (bt-3's `Executed{per-target dmg, hit, flank, guard}`).
/// `damage` is the HP actually removed (after First-Stand's clamp). A miss has `damage 0`,
/// `effectiveness None` and every flag false. `StoodGround`/`StatusApplied` are separate events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetResult {
    pub unit: u32,
    pub hit: bool,
    pub damage: u16,
    pub effectiveness: Option<Effectiveness>,
    pub flank: bool,
    pub guard: bool,
    pub ko: bool,
}

/// Everything the rules emit. Exhaustive on purpose (an exhaustive `match` is the OCP gate);
/// bt-3's storage payload maps from these at execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TacticalEvent {
    Executed {
        attacker: u32,
        skill_id: u32,
        results: Vec<TargetResult>,
    },
    Missed {
        attacker: u32,
        target: u32,
    },
    StoodGround {
        unit: u32,
    },
    StatusApplied {
        unit: u32,
        status: StatusEffect,
    },
    StatusTick {
        unit: u32,
        status: StatusEffect,
        amount: u16,
    },
    StatusCured {
        unit: u32,
        status: StatusEffect,
    },
    Surge {
        round: u16,
        unit: u32,
        amount: u16,
    },
    Ko {
        unit: u32,
    },
    QueueVoided {
        unit: u32,
    },
    BattleEnd {
        outcome: BattleOutcome,
        how: BattleEndHow,
    },
}

/// One target's two draws from the private stream: `accuracy` in `0..100`, `variance` in `85..=100`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollPair {
    pub accuracy: u8,
    pub variance: u8,
}

/// Draw one target's [`RollPair`] from `splitmix64(seed ^ action_seq)`, advancing `action_seq`
/// (wrapping) once per value: accuracy = `% 100` first, then variance = `85 + % 16`.
pub fn draw_rolls(state: &mut TacticalState) -> RollPair {
    let _ = state;
    todo!("bt-2 resolve: draw_rolls")
}

/// Every intermediate of the pipeline for one target (the golden vectors pin the order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineTrace {
    pub hit: bool,
    pub d0: u16,
    pub d1: u16,
    pub d2: u16,
    pub d3: u16,
    pub effectiveness: Option<Effectiveness>,
    /// HP actually removed (after First-Stand's clamp).
    pub applied: u16,
    pub hp_after: u16,
    pub stood_ground: bool,
}

/// The pure §2.4 pipeline for one target with the rolls already drawn. Mutates nothing.
#[must_use]
pub fn damage_pipeline(
    attacker: &TacticalUnit,
    target: &TacticalUnit,
    skill: &SkillTactics,
    chart: &TypeChart,
    flank: bool,
    rolls: RollPair,
    t: &TacticsTuning,
) -> PipelineTrace {
    let _ = (attacker, target, skill, chart, flank, rolls, t);
    todo!("bt-2 resolve: damage_pipeline")
}

/// Why an attack entry is INVALID (0 AP, no rolls drawn, state untouched).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolveError {
    Act(ActError),
    UnknownSkill { unit: u32, skill_id: u32 },
    Geometry(GeometryError),
    Economy(EconomyError),
}

/// What one resolved attack did. Whether the actor KO'd itself (an `All`-filter AoE → the
/// executor ends its turn) or the battle ended is read from the state (`can_act`, `outcome`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttackOutcome {
    pub events: Vec<TacticalEvent>,
    pub ap_spent: u8,
}

/// Resolve one attack entry: snapshot (`StepSnapshot::capture`), validate (`can_act` → skill in
/// kit → `target_set` → `spend`), then per target in `target_set` order draw accuracy and
/// variance (both, hit or miss; exactly two draws per target), run [`damage_pipeline`] with flank
/// evaluated on the PRE-attack board, apply HP / First-Stand / status (the carried rule: hit, not
/// immune, not KO'd, no prior status; Sleep arrives with 3 turns), add enemy-side `damage` to
/// `attack_damage_dealt[attacker.side]`, then emit `Executed` (an empty target set is a valid
/// attack: AP spent, no draws, `results: []`), the per-target detail events in target order
/// (`Missed` | `StoodGround`, `StatusApplied`), and `outcome::settle`'s events.
///
/// # Errors
/// An invalid entry ([`ResolveError`]) leaves `state` byte-identical (0 AP, no draws).
pub fn resolve_attack(
    state: &mut TacticalState,
    attacker: u32,
    skill_id: u32,
    aim: Cell,
    chart: &TypeChart,
    t: &TacticsTuning,
) -> Result<AttackOutcome, ResolveError> {
    let _ = (state, attacker, skill_id, aim, chart, t);
    todo!("bt-2 resolve: resolve_attack")
}
