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
use crate::combat::damage::{accuracy_check, calc_damage};
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{BattleMonster, BattleOutcome, Effectiveness, StatusEffect};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};

use super::economy::{
    apply_flank, apply_guard, guard_granted, spend, EconomyError, Entry, Tier, TurnBudget,
    TurnEndCause,
};
use super::geometry::{
    is_flanked, target_set, Board, BoardUnit, Cell, GeometryError, Side, SkillGeometry,
};
use super::initiative::{order, priority_for_round, round1_priority, Contender};
use super::map::BattleMapDef;
use super::movement::{MoveClass, Terrain};
use super::outcome::{settle, BattleEndHow, StepSnapshot};
use super::tuning::{BattleKind, TacticsTuning, TuningError};

/// The canonical splitmix64 output for state `x` (`crate::tick_seed(x, 0, 0)`):
/// `splitmix64(0) == 0xE220_A839_7B1D_CDAF`. Every tactics roll and coin is one of these.
#[must_use]
pub fn splitmix64(x: u64) -> u64 {
    crate::tick_seed(x, 0, 0)
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
        self.kit.stats.hp
    }

    /// `state == Active && cur_hp > 0`.
    #[must_use]
    pub fn is_conscious(&self) -> bool {
        self.state == UnitState::Active && self.cur_hp > 0
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
    let id = unit.id;
    if unit.cur_hp == 0 {
        return Err(DeployError::Fainted { id });
    }
    if unit.cur_hp > unit.max_hp() {
        return Err(DeployError::HpAboveMax {
            id,
            cur_hp: unit.cur_hp,
            max_hp: unit.max_hp(),
        });
    }
    if unit.kit.stats.defense == 0 {
        return Err(DeployError::ZeroDefense { id });
    }
    Ok(())
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
    let unit = TacticalUnit {
        id,
        side,
        slot,
        kit,
        pos,
        cur_hp,
        status: None,
        budget: TurnBudget::default(),
        guard: false,
        first_stand: true,
        state: UnitState::Active,
    };
    validate_unit(&unit)?;
    Ok(unit)
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
    /// Row-major LoS blockers (the map's `blocks_los`; all false on every P1 map).
    pub blocks_los: Vec<bool>,
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
    /// Precondition: `map` passed `map::validate_battle_map` (the caller loads validated content;
    /// the tile grid is copied as-is).
    ///
    /// # Errors
    /// See [`DeployError`].
    pub fn new(
        kind: BattleKind,
        seed: u64,
        map: &BattleMapDef,
        mut units: Vec<TacticalUnit>,
    ) -> Result<Self, DeployError> {
        for unit in &units {
            validate_unit(unit)?;
        }
        for (i, unit) in units.iter().enumerate() {
            if units[..i].iter().any(|u| u.id == unit.id) {
                return Err(DeployError::DuplicateId { id: unit.id });
            }
        }
        for (i, unit) in units.iter().enumerate() {
            if units[..i]
                .iter()
                .any(|u| u.side == unit.side && u.slot == unit.slot)
            {
                return Err(DeployError::DuplicateSlot {
                    side: unit.side,
                    slot: unit.slot,
                });
            }
        }
        for (i, unit) in units.iter().enumerate() {
            let off_map = unit.pos.x >= map.width || unit.pos.y >= map.height;
            if off_map || units[..i].iter().any(|u| u.pos == unit.pos) {
                return Err(DeployError::BadPosition { id: unit.id });
            }
        }
        for side in [Side::A, Side::B] {
            if !units.iter().any(|u| u.side == side) {
                return Err(DeployError::EmptySide { side });
            }
        }
        units.sort_by_key(|u| (side_index(u.side), u.slot));
        let mut state = TacticalState {
            kind,
            seed,
            action_seq: 0,
            round: 1,
            width: map.width,
            height: map.height,
            terrain: map.tiles.iter().map(|t| t.terrain).collect(),
            blocks_los: map.tiles.iter().map(|t| t.blocks_los).collect(),
            units,
            initiative: Vec::new(),
            queued: Vec::new(),
            attack_damage_dealt: [0, 0],
            outcome: BattleOutcome::Ongoing,
        };
        state.rebuild_initiative();
        Ok(state)
    }

    /// The geometry/movement view: `alive = is_conscious()`.
    #[must_use]
    pub fn board(&self) -> Board {
        Board {
            width: self.width,
            height: self.height,
            terrain: self.terrain.clone(),
            blocks_los: self.blocks_los.clone(),
            units: self.units.iter().map(board_unit_of).collect(),
        }
    }

    #[must_use]
    pub fn unit(&self, id: u32) -> Option<&TacticalUnit> {
        self.units.iter().find(|u| u.id == id)
    }

    pub fn unit_mut(&mut self, id: u32) -> Option<&mut TacticalUnit> {
        self.units.iter_mut().find(|u| u.id == id)
    }

    /// `priority_for_round(round1_priority(kind, seed), round)`.
    #[must_use]
    pub fn tie_priority(&self) -> Side {
        priority_for_round(round1_priority(self.kind, self.seed), self.round)
    }

    /// The conscious units as comparator inputs (`eff_speed` = the carried `stats.speed`; M14 has
    /// no speed-modifying status — a future modifier is applied here, once).
    #[must_use]
    pub fn contenders(&self) -> Vec<Contender> {
        self.units
            .iter()
            .filter(|u| u.is_conscious())
            .map(|u| Contender {
                id: u.id,
                side: u.side,
                slot: u.slot,
                eff_speed: u.kit.stats.speed,
                base_speed: u.kit.base_speed,
            })
            .collect()
    }

    /// `initiative = order(contenders, tie_priority)`.
    pub fn rebuild_initiative(&mut self) {
        self.initiative = order(&self.contenders(), self.tie_priority());
    }

    /// Drop `id` from `initiative` and `queued` (the only mid-round edits; a recruit removal
    /// calls this too). Returns whether `id` was in the initiative.
    pub fn remove_from_initiative(&mut self, id: u32) -> bool {
        let present = self.initiative.contains(&id);
        self.initiative.retain(|&u| u != id);
        self.queued.retain(|&u| u != id);
        present
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
    if state.outcome != BattleOutcome::Ongoing {
        return Err(ActError::BattleOver);
    }
    let unit = state.unit(id).ok_or(ActError::UnknownUnit(id))?;
    match unit.state {
        UnitState::Recruited => Err(ActError::Recruited(id)),
        UnitState::Fainted => Err(ActError::Fainted(id)),
        UnitState::Active if unit.cur_hp == 0 => Err(ActError::Fainted(id)),
        UnitState::Active => Ok(()),
    }
}

/// TurnStart: a fresh budget, Guard off, First-Stand cleared (an auto-pass still activates).
///
/// # Errors
/// [`can_act`]'s.
pub fn turn_start(state: &mut TacticalState, id: u32, t: &TacticsTuning) -> Result<(), ActError> {
    can_act(state, id)?;
    let unit = state.unit_mut(id).ok_or(ActError::UnknownUnit(id))?;
    unit.budget = TurnBudget::fresh(t);
    unit.guard = false;
    unit.first_stand = false;
    Ok(())
}

/// TurnEnd: sets the unit's Guard per `economy::guard_granted` (read from its budget), then
/// resets the budget to idle (`TurnBudget::default()`) so nothing can be spent until its next
/// TurnStart. Returns the unit's Guard. A unit whose budget is already idle (its turn never
/// started, or already ended) is left untouched: a second TurnEnd is a no-op that reports the
/// standing Guard, never a revocation.
///
/// # Errors
/// [`can_act`]'s.
pub fn turn_end(
    state: &mut TacticalState,
    id: u32,
    cause: TurnEndCause,
    t: &TacticsTuning,
) -> Result<bool, ActError> {
    can_act(state, id)?;
    let unit = state.unit_mut(id).ok_or(ActError::UnknownUnit(id))?;
    if unit.budget == TurnBudget::default() {
        return Ok(unit.guard);
    }
    let guard = guard_granted(cause, &unit.budget, t);
    unit.guard = guard;
    unit.budget = TurnBudget::default();
    Ok(guard)
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
    let accuracy = (draw(state) % 100) as u8;
    let variance = 85 + (draw(state) % 16) as u8;
    RollPair { accuracy, variance }
}

/// ONE value from the private stream — `splitmix64(seed ^ action_seq)` — advancing
/// `action_seq` (wrapping). Every tactics roll goes through here, so the stream cannot fork.
pub(crate) fn draw(state: &mut TacticalState) -> u64 {
    let value = splitmix64(state.seed ^ state.action_seq);
    state.action_seq = state.action_seq.wrapping_add(1);
    value
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
/// Preconditions (enforced by `resolve_attack` and the golden harness, not here): both units
/// pass [`validate_unit`] and `t.validate()` passed — the carried `calc_damage` divides by the
/// target's defense and Guard/flank by the tuning denominators.
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
    if !accuracy_check(skill.accuracy, rolls.accuracy) {
        return PipelineTrace {
            hit: false,
            d0: 0,
            d1: 0,
            d2: 0,
            d3: 0,
            effectiveness: None,
            applied: 0,
            hp_after: target.cur_hp,
            stood_ground: false,
        };
    }
    let (d0, effectiveness) = calc_damage(
        &battle_monster_of(attacker),
        &battle_monster_of(target),
        &skill_def_of(skill),
        chart,
        rolls.variance,
        None,
    );
    let d1 = if flank { apply_flank(d0, t) } else { d0 };
    let d2 = if target.guard { apply_guard(d1, t) } else { d1 };
    let d3 = if effectiveness == Effectiveness::Immune {
        0
    } else {
        d2.max(1)
    };
    let (applied, hp_after, stood_ground) =
        if target.first_stand && target.cur_hp > 0 && d3 >= target.cur_hp {
            (target.cur_hp - 1, 1, true)
        } else {
            let applied = d3.min(target.cur_hp);
            (applied, target.cur_hp - applied, false)
        };
    PipelineTrace {
        hit: true,
        d0,
        d1,
        d2,
        d3,
        effectiveness: Some(effectiveness),
        applied,
        hp_after,
        stood_ground,
    }
}

/// Why an attack entry is INVALID (0 AP, no rolls drawn, state untouched). `Tuning` and
/// `BadUnit` are the hostile-state guards: a state composed outside `TacticalState::new` (the
/// fields are public) or an unvalidated tuning is refused before any arithmetic can divide by
/// zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolveError {
    Act(ActError),
    UnknownSkill { unit: u32, skill_id: u32 },
    Geometry(GeometryError),
    Economy(EconomyError),
    Tuning(TuningError),
    BadUnit(DeployError),
}

/// What one resolved attack did. Whether the actor KO'd itself (an `All`-filter AoE → the
/// executor ends its turn) or the battle ended is read from the state (`can_act`, `outcome`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttackOutcome {
    pub events: Vec<TacticalEvent>,
    pub ap_spent: u8,
}

/// Resolve one attack entry: snapshot (`StepSnapshot::capture`), validate (`t.validate()` →
/// `can_act` → `validate_unit(actor)` → skill in kit → `target_set` → `validate_unit` on every
/// target → `spend`), then per target in `target_set` order draw accuracy and
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
    let snap = StepSnapshot::capture(state);
    t.validate().map_err(ResolveError::Tuning)?;
    can_act(state, attacker).map_err(ResolveError::Act)?;
    let actor = state
        .unit(attacker)
        .ok_or(ResolveError::Act(ActError::UnknownUnit(attacker)))?
        .clone();
    validate_unit(&actor).map_err(ResolveError::BadUnit)?;
    let skill = actor
        .kit
        .skills
        .iter()
        .find(|s| s.skill_id == skill_id)
        .cloned()
        .ok_or(ResolveError::UnknownSkill {
            unit: attacker,
            skill_id,
        })?;
    let board = state.board();
    let targets =
        target_set(&skill.geometry, attacker, aim, &board).map_err(ResolveError::Geometry)?;
    for target in targets.iter().filter_map(|&id| state.unit(id)) {
        validate_unit(target).map_err(ResolveError::BadUnit)?;
    }
    let ap_spent = {
        let unit = state
            .unit_mut(attacker)
            .ok_or(ResolveError::Act(ActError::UnknownUnit(attacker)))?;
        spend(&mut unit.budget, Entry::Attack(skill.tier), t).map_err(ResolveError::Economy)?
    };

    let mut results = Vec::with_capacity(targets.len());
    let mut details = Vec::new();
    for target_id in targets {
        let rolls = draw_rolls(state);
        let Some(target) = state.unit(target_id).cloned() else {
            continue;
        };
        let flank = is_flanked(attacker, target.pos, &board.units);
        let trace = damage_pipeline(&actor, &target, &skill, chart, flank, rolls, t);
        if !trace.hit {
            results.push(TargetResult {
                unit: target_id,
                hit: false,
                damage: 0,
                effectiveness: None,
                flank: false,
                guard: false,
                ko: false,
            });
            details.push(TacticalEvent::Missed {
                attacker,
                target: target_id,
            });
            continue;
        }
        let ko = trace.hp_after == 0;
        if let Some(unit) = state.unit_mut(target_id) {
            unit.cur_hp = trace.hp_after;
            if trace.stood_ground {
                unit.first_stand = false;
                details.push(TacticalEvent::StoodGround { unit: target_id });
            }
            let immune = trace.effectiveness == Some(Effectiveness::Immune);
            if !immune && !ko && unit.status.is_none() {
                if let Some(kind) = skill.applies_status {
                    let status = status_of(kind);
                    unit.status = Some(status);
                    details.push(TacticalEvent::StatusApplied {
                        unit: target_id,
                        status,
                    });
                }
            }
        }
        if target.side != actor.side {
            let tally = &mut state.attack_damage_dealt[side_index(actor.side)];
            *tally = tally.saturating_add(u32::from(trace.applied));
        }
        results.push(TargetResult {
            unit: target_id,
            hit: true,
            damage: trace.applied,
            effectiveness: trace.effectiveness,
            flank,
            guard: target.guard,
            ko,
        });
    }

    let mut events = vec![TacticalEvent::Executed {
        attacker,
        skill_id,
        results,
    }];
    events.extend(details);
    events.extend(settle(state, &snap));
    Ok(AttackOutcome { events, ap_spent })
}

/// The carried status a skill inflicts (`combat::resolve`: Sleep arrives with 3 turns).
fn status_of(kind: StatusKind) -> StatusEffect {
    match kind {
        StatusKind::Poison => StatusEffect::Poison,
        StatusKind::Burn => StatusEffect::Burn,
        StatusKind::Paralysis => StatusEffect::Paralysis,
        StatusKind::Sleep => StatusEffect::Sleep { turns_remaining: 3 },
        StatusKind::Freeze => StatusEffect::Freeze,
    }
}

/// The carried `BattleMonster` view of a unit for `calc_damage` (by value, no rule copied).
fn battle_monster_of(unit: &TacticalUnit) -> BattleMonster {
    BattleMonster {
        species_id: unit.kit.species_id,
        affinity: unit.kit.affinity,
        level: unit.kit.level,
        current_hp: unit.cur_hp,
        max_hp: unit.max_hp(),
        stats: unit.kit.stats,
        known_skill_ids: Vec::new(),
        status: unit.status,
    }
}

/// The carried `SkillDef` view of a tactical skill for `calc_damage`.
fn skill_def_of(skill: &SkillTactics) -> SkillDef {
    SkillDef {
        id: skill.skill_id,
        name: String::new(),
        affinity: skill.affinity,
        power: skill.power,
        accuracy: skill.accuracy,
        pp: 0,
        sets_weather: None,
        applies_status: skill.applies_status,
    }
}

/// The `BoardUnit` of a unit (`alive = is_conscious()`).
fn board_unit_of(unit: &TacticalUnit) -> BoardUnit {
    BoardUnit {
        id: unit.id,
        side: unit.side,
        pos: unit.pos,
        alive: unit.is_conscious(),
        class: unit.kit.class,
    }
}

/// Side → adjudication/damage array index (A = 0, B = 1).
pub(crate) fn side_index(side: Side) -> usize {
    match side {
        Side::A => 0,
        Side::B => 1,
    }
}
