//! Wild AI — design §4.2: the three stances + the universal Exhausted rule, **seed-free**.
//!
//! [`plan`] is a pure function of the public board. It takes no RNG and no seed parameter (the
//! compile shape); every rule below it reads a private `View` that carries no `seed`, `action_seq`
//! or budget (so a new stance has nothing secret to reach for), and it costs from a fresh budget —
//! so the client's intent chip (the same wasm build on the shared provisional board) and the
//! server's TurnStart plan can never disagree. A stance that wants randomness cannot compile
//! against a seed; it must move its telegraph into server-pushed `battle_event`s. Every choice is
//! one `min_by_key` over an explicit tuple, so native and wasm agree byte for byte.
//!
//! The plan is executed by the same executor as player queues (`queue::TacticalBattle`), so every
//! emitted entry is one `validate_at_pop` accepts: paths come from `movement::find_path`, aims
//! from `geometry::target_set`, the disengage tax from `movement::disengage_taxed`, stride points
//! from `queue::stride_points`, costs from `economy::plan_cost` (the trailing `EndTurn` included),
//! and every target-set unit passes `resolve::validate_unit`. No rule is re-implemented here.
//!
//! Tie-breaks: a target by `(Manhattan distance from the wild, cur_hp, slot, y, x)`; a tile by
//! `(the stance's primary, path cost, y, x)` — the wild's own tile costs 0, so staying put wins
//! every tie and a move needs a strict improvement; a skill by its position in the kit.

use std::cmp::Reverse;

use serde::{Deserialize, Serialize};

use super::economy::{plan_cost, Entry, Tier, TurnBudget};
use super::geometry::{manhattan, target_set, Board, Cell, Origin};
use super::movement::{disengage_taxed, find_path};
use super::queue::stride_points;
use super::resolve::{can_act, validate_unit, SkillTactics, TacticalState, TacticalUnit};
use super::tuning::TacticsTuning;
use super::types::{ActionTarget, MoveAction, QueuedAction, SkillAction};

/// Species stance (content `battler.stance`, joined by bt-6). Serde only — never a wire type (it is
/// re-derived from the species, not stored). Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stance {
    Aggressive,
    Territorial,
    Skittish,
}

/// Design §4.2: a Territorial wild never ends a move farther than this from its spawn tile.
const TERRITORIAL_LEASH: u16 = 2;
/// Design §4.2: a Skittish wild kites within `heavy range_max + KITE_BAND_PAD` of the nearest player.
const KITE_BAND_PAD: u16 = 2;
/// Design §4.2: Exhausted when `cur_hp × EXHAUSTED_FACTOR < max_hp`.
const EXHAUSTED_FACTOR: u32 = 4;

/// Design §4.2 — the universal Exhausted rule: `cur_hp × 4 < max_hp`, in u32.
#[must_use]
pub fn is_exhausted(cur_hp: u16, max_hp: u16) -> bool {
    u32::from(cur_hp) * EXHAUSTED_FACTOR < u32::from(max_hp)
}

/// THE wild planner. Pure function of `state`'s public board; no RNG, no seed; total (never
/// panics); costs from `TurnBudget::fresh(t)`; always ends with `EndTurn`; emits only `Move`,
/// `Skill` and `EndTurn`. `stance` is the species' `battler.stance`, `spawn` the wild's
/// `spawn_b[slot]` tile (the shell reads both from its rows). An actor that cannot act, a hostile
/// state (duplicate ids, an invalid actor, an unusable tuning) or a board with no conscious enemy
/// plans `[EndTurn]`.
#[must_use]
pub fn plan(
    state: &TacticalState,
    unit: u32,
    stance: Stance,
    spawn: Cell,
    t: &TacticsTuning,
) -> Vec<QueuedAction> {
    let Some(view) = View::of(state, unit, t) else {
        return vec![QueuedAction::EndTurn];
    };
    let exhausted = is_exhausted(view.actor.cur_hp, view.actor.max_hp());
    let reach = view.reach();
    let tile_ok = |c: Cell| -> bool {
        if exhausted {
            c == view.actor.pos
        } else if stance == Stance::Territorial {
            c == view.actor.pos || manhattan(c, spawn) <= TERRITORIAL_LEASH
        } else {
            true
        }
    };
    let tier_ok = |tier: Tier| exhausted || stance != Stance::Skittish || tier == Tier::Heavy;
    let farthest = !exhausted && stance == Stance::Skittish;
    if let Some(attack) = view.attack(&reach, tile_ok, tier_ok, farthest) {
        return attack;
    }
    match (exhausted, stance) {
        (true, _) | (false, Stance::Territorial) => vec![QueuedAction::EndTurn],
        (false, Stance::Aggressive) => view.approach(&reach),
        (false, Stance::Skittish) => view.kite(&reach),
    }
}

/// A tile the wild can stand on this turn: its own (`cost 0`, `strides 0`) or one `find_path`
/// reaches within `strides` strides for the least such count.
#[derive(Clone, Copy)]
struct Reach {
    tile: Cell,
    cost: u16,
    strides: u8,
}

/// One way to attack: `target` from `reach.tile` with the `skill_idx`-th kit skill, aimed as `aim`.
struct Candidate<'a> {
    target: u32,
    reach: Reach,
    skill_idx: usize,
    skill: &'a SkillTactics,
    aim: ActionTarget,
}

/// The public board as the planner reads it — deliberately without `seed`, `action_seq` or the
/// actor's stored budget: every helper takes this, never the state.
struct View<'a> {
    board: Board,
    units: &'a [TacticalUnit],
    actor: &'a TacticalUnit,
    /// Conscious units of the other side, in `units` order.
    players: Vec<&'a TacticalUnit>,
    /// The disengage tax judged at the wild's CURRENT tile (the only Move start).
    taxed: bool,
    t: &'a TacticsTuning,
}

impl<'a> View<'a> {
    /// `None` when the wild plans `[EndTurn]` without looking: an unusable tuning, a unit that
    /// cannot act, a duplicated id (a bound `Unit(id)` would re-aim at the wrong twin), an invalid
    /// actor, an actor the movement rules refuse (off-board), or no conscious enemy.
    fn of(state: &'a TacticalState, unit: u32, t: &'a TacticsTuning) -> Option<View<'a>> {
        t.validate().ok()?;
        can_act(state, unit).ok()?;
        for (i, u) in state.units.iter().enumerate() {
            if state.units[..i].iter().any(|v| v.id == u.id) {
                return None;
            }
        }
        let actor = state.unit(unit)?;
        validate_unit(actor).ok()?;
        let board = state.board();
        let taxed = disengage_taxed(&board, unit, actor.pos).ok()?;
        let players: Vec<&TacticalUnit> = state
            .units
            .iter()
            .filter(|u| u.side != actor.side && u.is_conscious())
            .collect();
        if players.is_empty() {
            return None;
        }
        Some(View {
            board,
            units: &state.units,
            actor,
            players,
            taxed,
            t,
        })
    }

    /// The least Manhattan distance from `c` to a player.
    fn distance(&self, c: Cell) -> u16 {
        self.players
            .iter()
            .map(|p| manhattan(c, p.pos))
            .min()
            .unwrap_or(u16::MAX)
    }

    /// Every tile the wild can stand on this turn, row-major, its own tile first. Path cost is at
    /// least the Manhattan distance, so tiles beyond the stride budget are pruned before pathing.
    fn reach(&self) -> Vec<Reach> {
        let pos = self.actor.pos;
        let base_speed = self.actor.kit.base_speed;
        let max_points = stride_points(self.t.max_strides_per_turn, base_speed);
        let mut out = vec![Reach {
            tile: pos,
            cost: 0,
            strides: 0,
        }];
        for y in 0..self.board.height {
            for x in 0..self.board.width {
                let tile = Cell { x, y };
                if manhattan(pos, tile) > max_points {
                    continue;
                }
                // The own tile is already in `out`: `find_path` refuses it as `SameTile`.
                let Ok(path) = find_path(&self.board, self.actor.id, pos, tile) else {
                    continue;
                };
                let strides = (1..=self.t.max_strides_per_turn)
                    .find(|&s| stride_points(s, base_speed) >= path.cost);
                if let Some(strides) = strides {
                    out.push(Reach {
                        tile,
                        cost: path.cost,
                        strides,
                    });
                }
            }
        }
        out
    }

    /// The Move entry that reaches `r` (none for the wild's own tile).
    fn move_entry(&self, r: Reach) -> Option<Entry> {
        (r.strides > 0).then_some(Entry::Move {
            strides: r.strides,
            taxed: self.taxed,
        })
    }

    /// Whether `[Move?, Attack?, EndTurn]` is affordable from a fresh budget — costed exactly as
    /// emitted, the trailing `EndTurn` included.
    fn admissible(&self, r: Reach, attack: Option<Tier>) -> bool {
        let entries: Vec<Entry> = self
            .move_entry(r)
            .into_iter()
            .chain(attack.map(Entry::Attack))
            .chain(std::iter::once(Entry::EndTurn))
            .collect();
        plan_cost(&TurnBudget::fresh(self.t), &entries, self.t).is_ok()
    }

    /// The board with the wild standing on `tile`.
    fn board_at(&self, tile: Cell) -> Board {
        let mut board = self.board.clone();
        if let Some(me) = board.units.iter_mut().find(|u| u.id == self.actor.id) {
            me.pos = tile;
        }
        board
    }

    /// How `skill` cast from `tile` is aimed to hit `target`, if the ONE geometry function says it
    /// does: the target is in the set, the wild itself is not, and every unit in the set passes
    /// `validate_unit` (the execution gate's own check).
    fn hits(
        &self,
        board_at: &Board,
        tile: Cell,
        skill: &SkillTactics,
        target: &TacticalUnit,
    ) -> Option<ActionTarget> {
        let (aim, action) = match skill.geometry.origin {
            Origin::TargetUnit => (target.pos, ActionTarget::Unit(target.id)),
            Origin::Caster => (tile, ActionTarget::SelfTarget),
        };
        let ids = target_set(&skill.geometry, self.actor.id, aim, board_at).ok()?;
        let hits_target = ids.contains(&target.id) && !ids.contains(&self.actor.id);
        let all_valid = ids
            .iter()
            .filter_map(|&id| self.units.iter().find(|u| u.id == id))
            .all(|u| validate_unit(u).is_ok());
        (hits_target && all_valid).then_some(action)
    }

    /// Every `(target, tier, tile, skill)` attack the stance allows and the economy affords.
    fn candidates(
        &self,
        reach: &[Reach],
        tile_ok: impl Fn(Cell) -> bool,
        tier_ok: impl Fn(Tier) -> bool,
    ) -> Vec<Candidate<'a>> {
        let mut out = Vec::new();
        for &r in reach.iter().filter(|r| tile_ok(r.tile)) {
            let board_at = self.board_at(r.tile);
            for (skill_idx, skill) in self.actor.kit.skills.iter().enumerate() {
                // The gate and the resolver find a skill by id, first match: a later kit entry that
                // repeats an id can never be the one executed, so it is never the one planned.
                let shadowed = self.actor.kit.skills[..skill_idx]
                    .iter()
                    .any(|s| s.skill_id == skill.skill_id);
                if shadowed || !tier_ok(skill.tier) || !self.admissible(r, Some(skill.tier)) {
                    continue;
                }
                for target in &self.players {
                    if let Some(aim) = self.hits(&board_at, r.tile, skill, target) {
                        out.push(Candidate {
                            target: target.id,
                            reach: r,
                            skill_idx,
                            skill,
                            aim,
                        });
                    }
                }
            }
        }
        out
    }

    /// The attack plan, if any player is attackable: the target by the tie-break, Heavy before
    /// Light, the tile by `(primary, cost, y, x)` — `primary` is the distance to the nearest player
    /// reversed for `farthest` (Skittish), 0 otherwise — then the first skill in kit order.
    fn attack(
        &self,
        reach: &[Reach],
        tile_ok: impl Fn(Cell) -> bool,
        tier_ok: impl Fn(Tier) -> bool,
        farthest: bool,
    ) -> Option<Vec<QueuedAction>> {
        let candidates = self.candidates(reach, tile_ok, tier_ok);
        let pos = self.actor.pos;
        let target = self
            .players
            .iter()
            .filter(|p| candidates.iter().any(|c| c.target == p.id))
            .min_by_key(|p| (manhattan(pos, p.pos), p.cur_hp, p.slot, p.pos.y, p.pos.x))?;
        let tier = if candidates
            .iter()
            .any(|c| c.target == target.id && c.skill.tier == Tier::Heavy)
        {
            Tier::Heavy
        } else {
            Tier::Light
        };
        let best = candidates
            .iter()
            .filter(|c| c.target == target.id && c.skill.tier == tier)
            .min_by_key(|c| {
                let primary = farthest.then(|| Reverse(self.distance(c.reach.tile)));
                (
                    primary,
                    c.reach.cost,
                    c.reach.tile.y,
                    c.reach.tile.x,
                    c.skill_idx,
                )
            })?;
        let mut out = Vec::with_capacity(3);
        out.extend(move_action(best.reach));
        out.push(QueuedAction::Skill(SkillAction {
            skill_id: best.skill.skill_id,
            target: best.aim,
        }));
        out.push(QueuedAction::EndTurn);
        Some(out)
    }

    /// The reachable tiles an unarmed `[Move?, EndTurn]` can afford.
    fn open<'r>(&'r self, reach: &'r [Reach]) -> impl Iterator<Item = Reach> + 'r {
        reach
            .iter()
            .copied()
            .filter(move |&r| self.admissible(r, None))
    }

    /// Aggressive: the reachable tile with the least distance to the nearest player, by
    /// `(distance, cost, y, x)` — the wild's own tile (cost 0) wins a tie.
    fn approach(&self, reach: &[Reach]) -> Vec<QueuedAction> {
        let best = self
            .open(reach)
            .min_by_key(|r| (self.distance(r.tile), r.cost, r.tile.y, r.tile.x));
        best.map_or_else(|| vec![QueuedAction::EndTurn], move_plan)
    }

    /// Skittish: within `heavy range_max + 2` of the nearest player, the farthest reachable tile by
    /// `(Reverse(distance), cost, y, x)`; out of band with nothing in band in reach, the approach.
    fn kite(&self, reach: &[Reach]) -> Vec<QueuedAction> {
        let heavy_range = self
            .actor
            .kit
            .skills
            .iter()
            .filter(|s| s.tier == Tier::Heavy)
            .map(|s| u16::from(s.geometry.range_max))
            .max()
            .unwrap_or(0);
        let band = heavy_range + KITE_BAND_PAD;
        let best = self
            .open(reach)
            .filter(|r| self.distance(r.tile) <= band)
            .min_by_key(|r| (Reverse(self.distance(r.tile)), r.cost, r.tile.y, r.tile.x));
        best.map_or_else(|| self.approach(reach), move_plan)
    }
}

/// `[Move?, EndTurn]` to `r` (just `[EndTurn]` for the wild's own tile).
fn move_plan(r: Reach) -> Vec<QueuedAction> {
    move_action(r)
        .into_iter()
        .chain(std::iter::once(QueuedAction::EndTurn))
        .collect()
}

/// The emitted Move for `r` (none for the wild's own tile).
fn move_action(r: Reach) -> Option<QueuedAction> {
    (r.strides > 0).then_some(QueuedAction::Move(MoveAction {
        x: r.tile.x,
        y: r.tile.y,
        strides: r.strides,
    }))
}
