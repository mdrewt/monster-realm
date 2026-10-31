//! Golden harness — design §11 T1: the native = wasm byte-identity proof.
//!
//! `run_golden` evaluates a list of [`GoldenCase`]s with the real tactics rules. The
//! shared fixture `game-core/tests/fixtures/tactics_golden.json` is asserted natively
//! (`golden_tests.rs`) and through the `tactics_golden` wasm export
//! (`client/src/tactics/golden.parity.test.ts`); both compare the same canonical JSON.
//! Every later tactics module adds its case kinds here (bt-2 joined with the economy, initiative,
//! pipeline, resolve, upkeep and adjudication kinds; BT4.8, BT11.7 follow). No rule lives in this
//! file — it only adapts fixture data to the rule functions. Every result value is ≤ u32 so the JS
//! side compares exact Numbers; u64 INPUTS (seeds) stay below 2^53 in the fixture.

use serde::{Deserialize, Serialize};

use crate::combat::types::{BattleOutcome, StatusEffect};

use super::economy::{EconomyError, Entry};
use super::geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    GeometryError, Side, SkillGeometry,
};
use super::initiative::Contender;
use super::movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};
use super::outcome::Adjudication;
use super::resolve::{
    BattleKind, PipelineTrace, ResolveError, RollPair, SkillTactics, TacticalEvent, TacticalState,
    TacticalUnit, UnitState,
};

/// A compact board: `rows[y]` chars `.` Plain, `r` Rough, `w` Water, `#` Blocked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoldenBoard {
    pub rows: Vec<String>,
    pub units: Vec<BoardUnit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoldenCase {
    Distance {
        a: Cell,
        b: Cell,
    },
    Adjacent {
        a: Cell,
        b: Cell,
    },
    TargetSet {
        board: GoldenBoard,
        caster: u32,
        aim: Cell,
        geometry: SkillGeometry,
    },
    Flank {
        units: Vec<BoardUnit>,
        attacker: u32,
        target: Cell,
    },
    Los {
        board: GoldenBoard,
        from: Cell,
        to: Cell,
    },
    Stride {
        base_speed: u16,
    },
    Weight {
        class: MoveClass,
        terrain: Terrain,
    },
    Path {
        board: GoldenBoard,
        mover: u32,
        start: Cell,
        dest: Cell,
    },
    Disengage {
        board: GoldenBoard,
        mover: u32,
        start: Cell,
    },
    /// `draws` consecutive (accuracy, variance) pairs from `splitmix64(seed ^ action_seq)`.
    Rolls {
        seed: u64,
        action_seq: u64,
        draws: u8,
    },
    /// `economy::plan_cost` at the design tuning.
    Economy {
        entries: Vec<Entry>,
    },
    /// `economy::apply_guard` at the design tuning.
    Guard {
        damage: u16,
    },
    /// `economy::apply_flank` at the design tuning.
    FlankDamage {
        damage: u16,
    },
    /// `upkeep::surge_damage` at the design tuning.
    SurgeDamage {
        max_hp: u16,
        round: u16,
    },
    /// `upkeep::status_tick_damage`.
    StatusTick {
        status: StatusEffect,
        max_hp: u16,
    },
    /// `initiative::order`.
    Initiative {
        contenders: Vec<Contender>,
        priority: Side,
    },
    /// `priority_for_round(round1_priority(kind, seed), round)`.
    Priority {
        kind: BattleKind,
        seed: u64,
        round: u16,
    },
    /// `resolve::damage_pipeline` with the embedded type chart.
    Pipeline {
        attacker: TacticalUnit,
        target: TacticalUnit,
        skill: SkillTactics,
        flank: bool,
        rolls: RollPair,
    },
    /// `resolve::resolve_attack` on a whole battle.
    Resolve {
        battle: GoldenBattle,
        attacker: u32,
        skill_id: u32,
        aim: Cell,
    },
    /// `upkeep::run_upkeep` on a whole battle.
    Upkeep {
        battle: GoldenBattle,
    },
    /// `outcome::adjudicate` on a whole battle (snapshot taken as it stands).
    Adjudicate {
        battle: GoldenBattle,
    },
}

/// A compact whole battle: the glyph board of [`GoldenBoard`] plus the model's own fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoldenBattle {
    pub kind: BattleKind,
    pub seed: u64,
    pub action_seq: u64,
    pub round: u16,
    pub rows: Vec<String>,
    pub units: Vec<TacticalUnit>,
    pub queued: Vec<u32>,
    pub attack_damage_dealt: [u32; 2],
}

/// A unit after a `Resolve`/`Upkeep` case.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitAfter {
    pub id: u32,
    pub cur_hp: u16,
    pub state: UnitState,
    pub status: Option<StatusEffect>,
    pub guard: bool,
    pub first_stand: bool,
    pub ap: u8,
    pub attacks: u8,
}

/// The observable outcome of a whole-battle case. `draws` is how far `action_seq` advanced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BattleTrace {
    pub events: Vec<TacticalEvent>,
    pub units: Vec<UnitAfter>,
    pub round: u16,
    pub initiative: Vec<u32>,
    pub turn_idx: u8,
    pub queued: Vec<u32>,
    pub attack_damage_dealt: [u32; 2],
    pub draws: u32,
    pub outcome: BattleOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoldenResult {
    Distance(u16),
    Adjacent(bool),
    TargetSet(Result<Vec<u32>, GeometryError>),
    Flank(bool),
    Los(bool),
    Stride(u8),
    Weight(Option<u8>),
    Path(Result<Path, PathError>),
    Disengage(Result<bool, PathError>),
    Rolls(Vec<RollPair>),
    Economy(Result<u8, EconomyError>),
    Guard(u16),
    FlankDamage(u16),
    SurgeDamage(Option<u16>),
    StatusTick(Option<u16>),
    Initiative(Vec<u32>),
    Priority(Side),
    Pipeline(PipelineTrace),
    Resolve(Result<BattleTrace, ResolveError>),
    Upkeep(BattleTrace),
    Adjudicate((Side, Adjudication)),
    BadCase(String),
}

impl GoldenBattle {
    /// The rule-level [`TacticalState`] (round, seed and action_seq as given; initiative
    /// rebuilt), or the same `BadCase` text as [`GoldenBoard`] for a malformed board.
    fn to_state(&self) -> Result<TacticalState, String> {
        let _ = self;
        todo!("bt-2 golden: GoldenBattle::to_state")
    }
}

/// Everything a whole-battle case reports.
fn battle_trace(state: &TacticalState, events: Vec<TacticalEvent>, draws: u32) -> BattleTrace {
    let _ = (state, events, draws);
    todo!("bt-2 golden: battle_trace")
}

impl GoldenBoard {
    /// The rule-level [`Board`] (no LoS blockers), or the `BadCase` message for a
    /// malformed board, first match wins: empty, too large (> 255 rows or columns),
    /// then row by row a ragged row before an unknown terrain glyph.
    fn to_board(&self) -> Result<Board, String> {
        let width = self.rows.first().map_or(0, |r| r.chars().count());
        if width == 0 {
            return Err("empty board".to_owned());
        }
        let (Ok(w), Ok(h)) = (u8::try_from(width), u8::try_from(self.rows.len())) else {
            return Err("board too large".to_owned());
        };
        let mut terrain = Vec::with_capacity(width * self.rows.len());
        for (y, row) in self.rows.iter().enumerate() {
            if row.chars().count() != width {
                return Err(format!("ragged row {y}"));
            }
            for (x, c) in row.chars().enumerate() {
                terrain.push(match c {
                    '.' => Terrain::Plain,
                    'r' => Terrain::Rough,
                    'w' => Terrain::Water,
                    '#' => Terrain::Blocked,
                    other => return Err(format!("bad terrain '{other}' at ({x},{y})")),
                });
            }
        }
        Ok(Board {
            width: w,
            height: h,
            blocks_los: vec![false; terrain.len()],
            terrain,
            units: self.units.clone(),
        })
    }
}

fn run_case(case: &GoldenCase) -> Result<GoldenResult, String> {
    Ok(match case {
        GoldenCase::Distance { a, b } => GoldenResult::Distance(manhattan(*a, *b)),
        GoldenCase::Adjacent { a, b } => GoldenResult::Adjacent(is_adjacent(*a, *b)),
        GoldenCase::TargetSet {
            board,
            caster,
            aim,
            geometry,
        } => GoldenResult::TargetSet(target_set(geometry, *caster, *aim, &board.to_board()?)),
        GoldenCase::Flank {
            units,
            attacker,
            target,
        } => GoldenResult::Flank(is_flanked(*attacker, *target, units)),
        GoldenCase::Los { board, from, to } => {
            let b = board.to_board()?;
            GoldenResult::Los(line_of_sight(&b.blocks_los, b.width, *from, *to))
        }
        GoldenCase::Stride { base_speed } => {
            GoldenResult::Stride(stride_for_base_speed(*base_speed))
        }
        GoldenCase::Weight { class, terrain } => {
            GoldenResult::Weight(terrain_weight(*class, *terrain))
        }
        GoldenCase::Path {
            board,
            mover,
            start,
            dest,
        } => GoldenResult::Path(find_path(&board.to_board()?, *mover, *start, *dest)),
        GoldenCase::Disengage {
            board,
            mover,
            start,
        } => GoldenResult::Disengage(disengage_taxed(&board.to_board()?, *mover, *start)),
        GoldenCase::Rolls {
            seed,
            action_seq,
            draws,
        } => {
            let _ = (seed, action_seq, draws);
            todo!("bt-2 golden: Rolls")
        }
        GoldenCase::Economy { entries } => {
            let _ = entries;
            todo!("bt-2 golden: Economy")
        }
        GoldenCase::Guard { damage } => {
            let _ = damage;
            todo!("bt-2 golden: Guard")
        }
        GoldenCase::FlankDamage { damage } => {
            let _ = damage;
            todo!("bt-2 golden: FlankDamage")
        }
        GoldenCase::SurgeDamage { max_hp, round } => {
            let _ = (max_hp, round);
            todo!("bt-2 golden: SurgeDamage")
        }
        GoldenCase::StatusTick { status, max_hp } => {
            let _ = (status, max_hp);
            todo!("bt-2 golden: StatusTick")
        }
        GoldenCase::Initiative {
            contenders,
            priority,
        } => {
            let _ = (contenders, priority);
            todo!("bt-2 golden: Initiative")
        }
        GoldenCase::Priority { kind, seed, round } => {
            let _ = (kind, seed, round);
            todo!("bt-2 golden: Priority")
        }
        GoldenCase::Pipeline {
            attacker,
            target,
            skill,
            flank,
            rolls,
        } => {
            let _ = (attacker, target, skill, flank, rolls);
            todo!("bt-2 golden: Pipeline")
        }
        GoldenCase::Resolve {
            battle,
            attacker,
            skill_id,
            aim,
        } => {
            let s = battle.to_state()?;
            let _ = (s, attacker, skill_id, aim, battle_trace as fn(_, _, _) -> _);
            todo!("bt-2 golden: Resolve")
        }
        GoldenCase::Upkeep { battle } => {
            let _ = battle.to_state()?;
            todo!("bt-2 golden: Upkeep")
        }
        GoldenCase::Adjudicate { battle } => {
            let _ = battle.to_state()?;
            todo!("bt-2 golden: Adjudicate")
        }
    })
}

/// Evaluate every case, in order — one result per case. A malformed board yields
/// [`GoldenResult::BadCase`], never a panic.
#[must_use]
pub fn run_golden(cases: &[GoldenCase]) -> Vec<GoldenResult> {
    cases
        .iter()
        .map(|c| run_case(c).unwrap_or_else(GoldenResult::BadCase))
        .collect()
}
