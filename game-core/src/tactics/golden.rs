//! Golden harness — design §11 T1: the native = wasm byte-identity proof.
//!
//! `run_golden` evaluates a list of [`GoldenCase`]s with the real tactics rules. The
//! shared fixture `game-core/tests/fixtures/tactics_golden.json` is asserted natively
//! (`golden_tests.rs`) and through the `tactics_golden` wasm export
//! (`client/src/tactics/golden.parity.test.ts`); both compare the same canonical JSON.
//! Every later tactics module adds its case kinds here (bt-2 joined with the roll stream, economy,
//! initiative, priority, pipeline, Surge/status-tick and adjudication kinds; BT4.8, BT11.7 follow). No rule lives in this
//! file — it only adapts fixture data to the rule functions. Every result value is ≤ u32 so the JS
//! side compares exact Numbers; u64 INPUTS (seeds) stay below 2^53 in the fixture.

use serde::{Deserialize, Serialize};

use crate::combat::type_chart::TypeChart;
use crate::combat::types::{BattleOutcome, StatusEffect};
use crate::content::load_type_chart;

use super::ai::{plan, Stance};
use super::economy::{plan_cost, EconomyError, Entry, TurnBudget};
use super::geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    GeometryError, Side, SkillGeometry,
};
use super::initiative::{order, priority_for_round, round1_priority, Contender};
use super::movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};
use super::outcome::{adjudicate, Adjudication, StepSnapshot};
use super::resolve::{
    damage_pipeline, draw_rolls, validate_unit, PipelineTrace, RollPair, SkillTactics,
    TacticalState, TacticalUnit,
};
use super::types::QueuedAction;
use super::tuning::{BattleKind, TacticsTuning};
use super::upkeep::{status_tick_damage, surge_damage};

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
    /// `economy::plan_cost` from `start` at the design tuning.
    Economy {
        start: TurnBudget,
        entries: Vec<Entry>,
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
    /// `resolve::damage_pipeline` with the embedded type chart (both units pass `validate_unit`,
    /// else `BadCase`).
    Pipeline {
        attacker: TacticalUnit,
        target: TacticalUnit,
        skill: SkillTactics,
        flank: bool,
        rolls: RollPair,
    },
    /// `outcome::adjudicate` over explicit tuple inputs.
    Adjudicate {
        snapshot: StepSnapshot,
        attack_damage_dealt: [u32; 2],
        seed: u64,
        round: u16,
    },
    /// `ai::plan` on a frozen board (BT4.8): `rows` as in [`GoldenBoard`], the units as the
    /// `battle_unit` rows, the secret stream AS GIVEN (the planner must ignore it), at the design
    /// tuning. A malformed `rows` is a `BadCase` with the [`GoldenBoard`] texts.
    AiPlan {
        rows: Vec<String>,
        units: Vec<TacticalUnit>,
        seed: u64,
        action_seq: u64,
        unit: u32,
        stance: Stance,
        spawn: Cell,
    },
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
    SurgeDamage(Option<u16>),
    StatusTick(Option<u16>),
    Initiative(Vec<u32>),
    Priority(Side),
    Pipeline(PipelineTrace),
    Adjudicate((Side, Adjudication)),
    AiPlan(Vec<QueuedAction>),
    BadCase(String),
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
            let mut stream = roll_stream(*seed, *action_seq);
            GoldenResult::Rolls((0..*draws).map(|_| draw_rolls(&mut stream)).collect())
        }
        GoldenCase::Economy { start, entries } => {
            GoldenResult::Economy(plan_cost(start, entries, &TacticsTuning::DESIGN))
        }
        GoldenCase::SurgeDamage { max_hp, round } => {
            GoldenResult::SurgeDamage(surge_damage(*max_hp, *round, &TacticsTuning::DESIGN))
        }
        GoldenCase::StatusTick { status, max_hp } => {
            GoldenResult::StatusTick(status_tick_damage(status, *max_hp))
        }
        GoldenCase::Initiative {
            contenders,
            priority,
        } => GoldenResult::Initiative(order(contenders, *priority)),
        GoldenCase::Priority { kind, seed, round } => {
            GoldenResult::Priority(priority_for_round(round1_priority(*kind, *seed), *round))
        }
        GoldenCase::Pipeline {
            attacker,
            target,
            skill,
            flank,
            rolls,
        } => {
            validate_unit(attacker).map_err(|e| format!("invalid unit: {e:?}"))?;
            validate_unit(target).map_err(|e| format!("invalid unit: {e:?}"))?;
            let chart = TypeChart::new(&load_type_chart().map_err(|e| format!("type chart: {e}"))?);
            GoldenResult::Pipeline(damage_pipeline(
                attacker,
                target,
                skill,
                &chart,
                *flank,
                *rolls,
                &TacticsTuning::DESIGN,
            ))
        }
        GoldenCase::Adjudicate {
            snapshot,
            attack_damage_dealt,
            seed,
            round,
        } => GoldenResult::Adjudicate(adjudicate(snapshot, *attack_damage_dealt, *seed, *round)),
        GoldenCase::AiPlan {
            rows,
            units,
            seed,
            action_seq,
            unit,
            stance,
            spawn,
        } => {
            let _ = (rows, units, seed, action_seq, unit, stance, spawn, plan);
            todo!("bt-4 skeleton")
        }
    })
}

/// A unit-less battle carrying only the private stream, for the `Rolls` kind.
fn roll_stream(seed: u64, action_seq: u64) -> TacticalState {
    TacticalState {
        kind: BattleKind::Pvp,
        seed,
        action_seq,
        round: 1,
        width: 1,
        height: 1,
        terrain: vec![Terrain::Plain],
        blocks_los: vec![false],
        units: Vec::new(),
        initiative: Vec::new(),
        queued: Vec::new(),
        attack_damage_dealt: [0, 0],
        outcome: BattleOutcome::Ongoing,
    }
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
