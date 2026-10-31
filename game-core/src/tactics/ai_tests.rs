//! bt-4 gating tests — BT4.1–BT4.6 (`tactics::ai`). Written by the tester from the EARS criteria.
//!
//! Every expected plan is hand-derived from the plan's contract (bt-4 plan, "Contracts → ai.rs"
//! and the judgement calls J1–J15), never read back from an implementation. The derivation sits
//! in a comment above each row.
//!
//! # The arithmetic every derivation uses
//!
//! DESIGN tuning: 6 AP; a Move costs 2 AP per stride, plus the disengage tax 1 when a living enemy
//! is adjacent to the wild's CURRENT tile; Light 2; Heavy 4; EndTurn 0; at most 2 strides. From
//! a fresh budget that makes `[Heavy, End]` 4, `[Move1, Heavy, End]` 6, `[Move2, Heavy, End]` 8
//! (refused), `[Move1, Light, End]` 4, `[Move2, Light, End]` 6; and when taxed `[Move1, Heavy]` 7
//! (refused), `[Move1, Light]` 5, `[Move2, Light]` 7 (refused), `[Move1, End]` 3, `[Move2, End]` 5.
//!
//! Stride: a base speed of 49 or less buys 2 stride points per stride (one stride = two Plain
//! tiles), 50–89 buys 3, 90 and up buys 4. A Walk unit pays 1 per entered Plain tile and 2 per
//! Rough; Water, Blocked and a living enemy are walls. A Move's `strides` is the least `s` whose
//! `s × stride` covers the cheapest path cost (J3).
//!
//! `d(c)` is the least Manhattan distance from tile `c` to a conscious enemy ("player"). The
//! target key is `(distance from the wild's tile, cur_hp, slot, y, x)` ascending; the tile key is
//! `(primary, path cost, y, x)` ascending — the wild's own tile costs 0, so it wins every tie (J4).
//!
//! Boards are the 7×7 all-Plain `rt::open_map()`, patched where a test says so (rows `y`, columns
//! `x`, both 0..=6). The wild is unit 11 (side B, slot 0, 100 max HP, levelled speed 80 so it acts
//! before every player, base speed 30 = stride 2 unless stated). Players are side A, speed 30.
//!
//! Test names end in the criterion tag `_bt4_<k>`; the ledger CHECKs filter on it.

use std::cell::RefCell;

use proptest::prelude::*;
use proptest::test_runner::TestCaseError;

use crate::combat::types::BattleOutcome;
use crate::monster::types::Affinity;

use super::ai::{is_exhausted, plan, Stance};
use super::economy::{spend, Entry, Tier, TurnBudget};
use super::events::{EventPayload, MovedEvent, TurnEndedEvent};
use super::geometry::{manhattan, Cell, FfFilter, Origin, Shape, Side, SkillGeometry};
use super::map::{validate_battle_map, BattleMapDef, TileDef};
use super::movement::{MoveClass, Terrain};
use super::queue::{
    validate_at_pop, HaltReason, Hooks, Rules, StepResult, TacticalBattle, Validated,
};
use super::resolve::{SkillTactics, TacticalState, TacticalUnit, UnitState};
use super::resolve_tests as rt;
use super::tuning::{BattleKind, TacticsTuning};
use super::types::{ActionTarget, MoveAction, QueuedAction, SkillAction};

// ===========================================================================
// Fixtures
// ===========================================================================

const WILD: u32 = 11;
/// The wild's pack-mate (side B, slot 1) where a board has two wilds.
const MATE: u32 = 12;
const P1: u32 = 1;
const P2: u32 = 2;
const LIGHT: u32 = 10;
/// A second Light skill id (a kit-order tie).
const LIGHT2: u32 = 12;
const HEAVY: u32 = 20;
/// A second Heavy skill id (a kit-order / tile-before-skill / band tie).
const HEAVY2: u32 = 21;
const BURST: u32 = 30;
const END: QueuedAction = QueuedAction::EndTurn;
const STANCES: [Stance; 3] = [Stance::Aggressive, Stance::Territorial, Stance::Skittish];

/// A single-target skill aimed at a unit `range_min..=range_max` away, enemies only.
fn single(range_min: u8, range_max: u8) -> SkillGeometry {
    SkillGeometry {
        range_min,
        range_max,
        origin: Origin::TargetUnit,
        shape: Shape::Single,
        radius: 0,
        ff_filter: FfFilter::Enemies,
    }
}

/// The radius-1 ring around the caster (aim = the caster's own tile), enemies only.
fn caster_burst() -> SkillGeometry {
    SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Burst,
        radius: 1,
        ff_filter: FfFilter::Enemies,
    }
}

/// A radius-1 diamond aimed 1..=2 away that hits EVERYONE inside it (the caster too, if inside).
fn diamond_all() -> SkillGeometry {
    SkillGeometry {
        range_min: 1,
        range_max: 2,
        origin: Origin::TargetUnit,
        shape: Shape::Diamond,
        radius: 1,
        ff_filter: FfFilter::All,
    }
}

/// A radius-1 diamond centred on the CASTER (range 0, aim = its own tile) that hits everyone in
/// it — so it always holds the caster itself.
fn caster_diamond_all() -> SkillGeometry {
    SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Diamond,
        radius: 1,
        ff_filter: FfFilter::All,
    }
}

/// The reserved `Line` shape (`target_set` refuses it as `Unsupported`).
fn line() -> SkillGeometry {
    SkillGeometry {
        range_min: 1,
        range_max: 3,
        origin: Origin::TargetUnit,
        shape: Shape::Line,
        radius: 0,
        ff_filter: FfFilter::Enemies,
    }
}

fn lt(skill_id: u32, geometry: SkillGeometry) -> SkillTactics {
    rt::light(skill_id, Affinity::Fire, geometry)
}

fn hv(skill_id: u32, geometry: SkillGeometry) -> SkillTactics {
    rt::heavy(skill_id, Affinity::Fire, 65, geometry)
}

/// Light 10 melee, Heavy 20 melee.
fn melee_kit() -> Vec<SkillTactics> {
    vec![lt(LIGHT, single(1, 1)), hv(HEAVY, single(1, 1))]
}

/// The J9 kit: Light 10 single r1–3, Heavy 20 melee.
fn reach_kit() -> Vec<SkillTactics> {
    vec![lt(LIGHT, single(1, 3)), hv(HEAVY, single(1, 1))]
}

/// Light 10 and Heavy 20, both single r2–3: neither hits an ADJACENT unit.
fn ranged_kit() -> Vec<SkillTactics> {
    vec![lt(LIGHT, single(2, 3)), hv(HEAVY, single(2, 3))]
}

/// Light 10 melee, Heavy 20 single r2–3: only the Light hits an adjacent unit.
fn pinned_kit() -> Vec<SkillTactics> {
    vec![lt(LIGHT, single(1, 1)), hv(HEAVY, single(2, 3))]
}

/// Light 10 and Heavy 20, both single r1–3 (every tie-break board: both players in Heavy range).
fn far_kit() -> Vec<SkillTactics> {
    vec![lt(LIGHT, single(1, 3)), hv(HEAVY, single(1, 3))]
}

/// The wild under test (unit 11, side B, slot 0) at `(x, y)`: `max_hp` (stats.hp) at `hp`,
/// levelled speed 80, base speed `base`, carrying `skills`.
fn wild(x: u8, y: u8, max_hp: u16, hp: u16, base: u16, skills: Vec<SkillTactics>) -> TacticalUnit {
    rt::unit(
        WILD,
        Side::B,
        0,
        rt::c(x, y),
        rt::kit(
            2,
            Affinity::Water,
            5,
            rt::stat_block(max_hp, 10, rt::CHIP_DEF, 80),
            base,
            MoveClass::Walk,
            skills,
        ),
        hp,
    )
}

/// The wild's pack-mate (unit 12, side B, slot 1) at `(x, y)`: 100/100 HP, levelled speed 70 —
/// slower than unit 11, faster than every player — base speed 30, carrying `skills`.
fn pack_mate(x: u8, y: u8, skills: Vec<SkillTactics>) -> TacticalUnit {
    rt::unit(
        MATE,
        Side::B,
        1,
        rt::c(x, y),
        rt::kit(
            2,
            Affinity::Water,
            5,
            rt::stat_block(100, 10, rt::CHIP_DEF, 70),
            30,
            MoveClass::Walk,
            skills,
        ),
        100,
    )
}

/// A side-A player (100 max HP at `hp`, speed 30, no skills).
fn player(id: u32, slot: u8, x: u8, y: u8, hp: u16) -> TacticalUnit {
    rt::unit(
        id,
        Side::A,
        slot,
        rt::c(x, y),
        rt::water(100, rt::CHIP_DEF, 30, Vec::new()),
        hp,
    )
}

/// A wild battle on the 7×7 open map with `patches` applied to the terrain (row-major `y·7 + x`).
fn board(units: Vec<TacticalUnit>, patches: &[(u8, u8, Terrain)]) -> TacticalState {
    let mut st = rt::state(BattleKind::Wild, 0, units);
    let width = usize::from(st.width);
    for &(x, y, terrain) in patches {
        st.terrain[usize::from(y) * width + usize::from(x)] = terrain;
    }
    st
}

/// A 7×7 all-Plain wild battle composed by struct literal — NOT `TacticalState::new`, so the
/// units keep the given order and may share a slot or a tile.
fn forged(units: Vec<TacticalUnit>) -> TacticalState {
    TacticalState {
        kind: BattleKind::Wild,
        seed: 0,
        action_seq: 0,
        round: 1,
        width: 7,
        height: 7,
        terrain: vec![Terrain::Plain; 49],
        blocks_los: vec![false; 49],
        units,
        initiative: Vec::new(),
        queued: Vec::new(),
        attack_damage_dealt: [0, 0],
        outcome: BattleOutcome::Ongoing,
    }
}

/// The wild at (3,3) right beside P1 at (4,3).
fn duel(skills: Vec<SkillTactics>) -> TacticalState {
    board(
        vec![wild(3, 3, 100, 100, 30, skills), player(P1, 0, 4, 3, 100)],
        &[],
    )
}

/// The wild at (1,3) at `hp`/100, P1 three tiles east at (4,3).
fn three_apart(hp: u16, skills: Vec<SkillTactics>) -> TacticalState {
    board(
        vec![wild(1, 3, 100, hp, 30, skills), player(P1, 0, 4, 3, 100)],
        &[],
    )
}

/// The wild at (0,3), P1 four tiles east at (4,3), melee kit.
fn four_apart() -> TacticalState {
    board(
        vec![
            wild(0, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 4, 3, 100),
        ],
        &[],
    )
}

/// The wild at (0,3), P1 six tiles east at (6,3), melee kit.
fn six_apart() -> TacticalState {
    board(
        vec![
            wild(0, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 6, 3, 100),
        ],
        &[],
    )
}

fn mv(x: u8, y: u8, strides: u8) -> QueuedAction {
    QueuedAction::Move(MoveAction { x, y, strides })
}

fn hit(skill_id: u32, target: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id,
        target: ActionTarget::Unit(target),
    })
}

fn burst(skill_id: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id,
        target: ActionTarget::SelfTarget,
    })
}

/// `plan` for the wild at the design tuning.
fn plan_of(st: &TacticalState, stance: Stance, spawn: Cell) -> Vec<QueuedAction> {
    plan(st, WILD, stance, spawn, &rt::design())
}

/// `st` after `edit` (the hostile-state rows).
fn edited(mut st: TacticalState, edit: impl FnOnce(&mut TacticalState)) -> TacticalState {
    edit(&mut st);
    st
}

/// `st`'s wild after `edit`.
fn with_wild(st: TacticalState, edit: impl FnOnce(&mut TacticalUnit)) -> TacticalState {
    edited(st, |s| {
        edit(s.unit_mut(WILD).expect("the wild is on the board"))
    })
}

// ---------------------------------------------------------------------------
// The executor seam: a minimal `Hooks` whose `plan_ai` is a one-line call into `ai::plan`
// (mirrors the shape of queue_tests' private `FakeHooks`; the shell's bt-9 impl is the same call).
// ---------------------------------------------------------------------------

/// One `plan_ai` call: the state the executor showed the hook, the unit, the plan returned.
struct Turn {
    shown: TacticalState,
    unit: u32,
    plan: Vec<QueuedAction>,
}

/// `plan_ai` = `ai::plan(state, unit, stance, spawn, &tuning)` with the stance and spawn looked up
/// per wild and the SAME tuning as `Rules` (J1). Wilds never use items, recruit or flee, so the
/// inventory hooks are inert.
struct AiHooks {
    wilds: Vec<(u32, Stance, Cell)>,
    tuning: TacticsTuning,
    turns: RefCell<Vec<Turn>>,
}

impl AiHooks {
    fn new(wilds: Vec<(u32, Stance, Cell)>, tuning: TacticsTuning) -> AiHooks {
        AiHooks {
            wilds,
            tuning,
            turns: RefCell::new(Vec::new()),
        }
    }

    fn plans(&self) -> Vec<(u32, Vec<QueuedAction>)> {
        self.turns
            .borrow()
            .iter()
            .map(|turn| (turn.unit, turn.plan.clone()))
            .collect()
    }
}

impl Hooks for AiHooks {
    fn item_count(&self, _unit: u32, _item_id: u32) -> u32 {
        0
    }

    fn take_item(&mut self, _unit: u32, _item_id: u32) -> bool {
        false
    }

    fn recruit_headroom(&self, _unit: u32) -> bool {
        false
    }

    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction> {
        let &(_, stance, spawn) = self
            .wilds
            .iter()
            .find(|w| w.0 == unit)
            .expect("plan_ai is only asked about a wild");
        let out = plan(state, unit, stance, spawn, &self.tuning);
        self.turns.borrow_mut().push(Turn {
            shown: state.clone(),
            unit,
            plan: out.clone(),
        });
        out
    }

    fn validate_delegated(
        &self,
        _state: &TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Result<(), HaltReason> {
        Ok(())
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

/// The gate's hooks for Move / Skill / EndTurn entries (none of those reads a hook). Shared with
/// `golden_tests.rs`'s gate replay.
pub(super) struct NoHooks;

impl Hooks for NoHooks {
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
        vec![QueuedAction::EndTurn]
    }

    fn validate_delegated(
        &self,
        _state: &TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Result<(), HaltReason> {
        Ok(())
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

/// `TacticalBattle::new(1, state).start(0, …)` with `wilds` planned by `ai::plan` at `t`.
fn start_battle(
    state: TacticalState,
    wilds: Vec<(u32, Stance, Cell)>,
    t: &TacticsTuning,
) -> (StepResult, TacticalBattle, AiHooks) {
    let chart = rt::chart();
    let mut hooks = AiHooks::new(wilds, t.clone());
    let mut battle = TacticalBattle::new(1, state);
    let out = battle
        .start(
            0,
            &Rules {
                chart: &chart,
                tuning: t,
            },
            &mut hooks,
        )
        .expect("a deployed battle starts");
    (out, battle, hooks)
}

fn halted(out: &StepResult) -> bool {
    out.events
        .iter()
        .any(|e| matches!(e, EventPayload::PlanHalted(_)))
}

// ===========================================================================
// BT4.1 — seed-free, a pure function of the public board, the tie-break
// ===========================================================================

/// BT4.1: the compile shape — `plan` takes the board, the unit, its stance and spawn and the
/// tuning, and NOTHING that could carry randomness. Called through the pinned pointer type on the
/// J9 board (reach-kit wild at (1,3), P1 at (4,3)) it answers the plan derived in
/// `an_aggressive_wild_prefers_heavy_after_a_stride_to_a_stationary_light_bt4_2`.
/// Kills: a seed or RNG parameter (no longer compiles); a stub behind the right signature.
#[test]
fn plan_answers_through_its_seed_free_compile_shape_bt4_1() {
    let shape: fn(&TacticalState, u32, Stance, Cell, &TacticsTuning) -> Vec<QueuedAction> = plan;
    let exhausted: fn(u16, u16) -> bool = is_exhausted;
    let st = three_apart(100, reach_kit());
    assert_eq!(
        shape(&st, WILD, Stance::Aggressive, rt::c(1, 3), &rt::design()),
        vec![mv(3, 3, 1), hit(HEAVY, P1), END]
    );
    // 100 × 4 = 400 is not below 100.
    assert!(!exhausted(100, 100));
}

/// BT4.1: on a board where the wild ATTACKS (the J9 board: Heavy after one stride), every seed ×
/// action_seq pair plans the same hand-derived `[Move (3,3) ×1, Heavy → P1, End]`.
/// Kills: any read of `seed` / `action_seq` (a hidden coin, a seeded shuffle of ties).
#[test]
fn the_plan_is_blind_to_the_secret_stream_on_a_board_where_the_wild_attacks_bt4_1() {
    let want = vec![mv(3, 3, 1), hit(HEAVY, P1), END];
    for seed in [0_u64, 1, (1_u64 << 53) - 1, u64::MAX] {
        for action_seq in [0_u64, 1, u64::MAX] {
            let mut st = three_apart(100, reach_kit());
            st.seed = seed;
            st.action_seq = action_seq;
            assert_eq!(
                plan_of(&st, Stance::Aggressive, rt::c(1, 3)),
                want,
                "seed {seed:#x}, action_seq {action_seq:#x}"
            );
        }
    }
}

/// BT4.1 / J14: the plan is costed from `TurnBudget::fresh(t)`, never from the wild's stored
/// budget: the idle budget (all zero — what every client and fixture board shows), a fresh one, a
/// spent one and a hostile one all plan the J9 answer `[Move (3,3) ×1, Heavy → P1, End]`. (Costed
/// from the idle budget nothing would be affordable: `[End]`.)
/// Kills: costing from `actor.budget` (idle → `[End]`; spent strides → no Move).
#[test]
fn the_plan_costs_from_a_fresh_budget_whatever_the_stored_one_bt4_1() {
    let t = rt::design();
    let want = vec![mv(3, 3, 1), hit(HEAVY, P1), END];
    let spent = TurnBudget {
        ap: 0,
        strides_used: 2,
        attacks: 1,
        last: Some(Entry::Attack(Tier::Heavy)),
    };
    let hostile = TurnBudget {
        ap: 255,
        strides_used: 255,
        attacks: 255,
        last: Some(Entry::Move {
            strides: 2,
            taxed: true,
        }),
    };
    for budget in [TurnBudget::default(), TurnBudget::fresh(&t), spent, hostile] {
        let st = with_wild(three_apart(100, reach_kit()), |w| w.budget = budget);
        assert_eq!(
            plan(&st, WILD, Stance::Aggressive, rt::c(1, 3), &t),
            want,
            "stored budget {budget:?}"
        );
    }
}

/// BT4.1 tie-break, key 1 (distance from the wild's tile). Wild at (3,3) with Light and Heavy
/// both r1–3; P1 (slot 0, 10 HP) at (0,3) is 3 away, P2 (slot 1, 90 HP) at (3,1) is 2 away. Both
/// are Heavy-attackable from the wild's own tile; the nearer P2 wins although its HP and slot are
/// higher. Tier Heavy (a candidate exists), tile = its own (cost 0) → `[Heavy → P2, End]`.
/// Kills: cur_hp or slot ranked before distance; the first player in `units` order.
#[test]
fn the_nearest_player_is_the_target_whatever_its_hp_bt4_1() {
    let st = board(
        vec![
            wild(3, 3, 100, 100, 30, far_kit()),
            player(P1, 0, 0, 3, 10),
            player(P2, 1, 3, 1, 90),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(3, 3)),
        vec![hit(HEAVY, P2), END]
    );
}

/// BT4.1 tie-break, key 2 (cur_hp) with the distance tied: P1 (slot 0, 90 HP) at (3,1) and P2
/// (slot 1, 40 HP) at (5,3) are both 2 from the wild at (3,3) → the weaker P2,
/// `[Heavy → P2, End]`. The Exhausted override (24 HP) picks its target by the same key.
/// Kills: slot / y / x ranked before cur_hp; the first player in `units` order; an Exhausted path
/// with its own target rule.
#[test]
fn at_equal_distance_the_lower_cur_hp_is_the_target_bt4_1() {
    let units = |wild_hp: u16| {
        vec![
            wild(3, 3, 100, wild_hp, 30, far_kit()),
            player(P1, 0, 3, 1, 90),
            player(P2, 1, 5, 3, 40),
        ]
    };
    let want = vec![hit(HEAVY, P2), END];
    assert_eq!(
        plan_of(&board(units(100), &[]), Stance::Aggressive, rt::c(3, 3)),
        want
    );
    // Exhausted (24 × 4 = 96 < 100): own tile only, Heavy still reaches P2 → the same plan.
    assert_eq!(
        plan_of(&board(units(24), &[]), Stance::Aggressive, rt::c(3, 3)),
        want
    );
}

/// BT4.1 tie-break, key 3 (slot) with distance and cur_hp tied: P1 (slot 1) at (3,1) and P2
/// (slot 0) at (5,3), both 50 HP, both 2 from the wild at (3,3). The units are listed P1 first
/// (a struct-literal state keeps the order), and P1 also has the lower id and the lower y — the
/// slot key alone names P2: `[Heavy → P2, End]`.
/// Kills: y / x / id ranked before slot; the first player in `units` order.
#[test]
fn at_equal_distance_and_hp_the_lower_slot_is_the_target_bt4_1() {
    let st = forged(vec![
        wild(3, 3, 100, 100, 30, far_kit()),
        player(P1, 1, 3, 1, 50),
        player(P2, 0, 5, 3, 50),
    ]);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(3, 3)),
        vec![hit(HEAVY, P2), END]
    );
}

/// BT4.1 tie-break, key 4 (y) — reachable only on a FORGED state (slots are unique per side on a
/// valid one): P1 at (5,3) and P2 at (3,1), both slot 0, 50 HP, 2 from the wild at (3,3). P2's
/// y = 1 beats P1's y = 3 although P1 is listed first and has the lower id: `[Heavy → P2, End]`.
/// Kills: x ranked before y; id or list order as the last key.
#[test]
fn on_a_forged_slot_tie_the_lower_y_is_the_target_bt4_1() {
    let st = forged(vec![
        wild(3, 3, 100, 100, 30, far_kit()),
        player(P1, 0, 5, 3, 50),
        player(P2, 0, 3, 1, 50),
    ]);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(3, 3)),
        vec![hit(HEAVY, P2), END]
    );
}

/// BT4.1 tie-break, key 5 (x), forged: P1 at (5,3) and P2 at (1,3), both slot 0, 50 HP, row 3,
/// 2 from the wild at (3,3) → P2 (x = 1): `[Heavy → P2, End]`.
/// Kills: a key without x (falls back to list order / id → P1).
#[test]
fn on_a_forged_slot_and_row_tie_the_lower_x_is_the_target_bt4_1() {
    let st = forged(vec![
        wild(3, 3, 100, 100, 30, far_kit()),
        player(P1, 0, 5, 3, 50),
        player(P2, 0, 1, 3, 50),
    ]);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(3, 3)),
        vec![hit(HEAVY, P2), END]
    );
}

/// BT4.1: every TIE board plans the answer derived on its seed-0 board for every seed {0, 1,
/// 2^53 − 1, u64::MAX} × action_seq {0, 1, u64::MAX} (the J9 board of the twin test above has no
/// tie, so a tie broken by a seed or counter bit escapes it about half the time). The boards and
/// their derivations are the round-1 rows named here:
/// - target key 2 (`at_equal_distance_the_lower_cur_hp_is_the_target_bt4_1`) → `[Heavy → P2, End]`;
/// - key 3, slot (forged) → `[Heavy → P2, End]`; key 4, y (forged) → `[Heavy → P2, End]`;
///   key 5, x (forged) → `[Heavy → P2, End]`;
/// - the approach tie by cost (`an_aggressive_approach_breaks_a_distance_tie_by_path_cost_…`:
///   (4,3) cost 2 vs (5,2) / (5,4) cost 4 at d 2) → `[Move (4,3) ×1, End]`;
/// - the Aggressive attack-tile tie (the taxed ranged duel: (3,2), (2,3), (3,4) all cost 1) →
///   `[Move (3,2) ×1, Light → P1, End]`;
/// - the Skittish farthest-tile tie ((2,2), (4,2), (3,3) all d 3, cost 1) →
///   `[Move (2,2) ×1, Heavy → P1, End]`;
/// - the skill tie (two Lights r1–3 both hitting P1 from the own tile, kit [10, 12]) →
///   `[Light 10 → P1, End]`.
///
/// Kills: a tie (target slot, approach tile, attack tile, skill) broken by any bit of `seed` or
/// `action_seq`.
#[test]
fn every_tie_break_answers_its_seed_zero_plan_whatever_the_secret_stream_bt4_1() {
    let ties = [
        (
            "target key 2 (cur_hp)",
            board(
                vec![
                    wild(3, 3, 100, 100, 30, far_kit()),
                    player(P1, 0, 3, 1, 90),
                    player(P2, 1, 5, 3, 40),
                ],
                &[],
            ),
            Stance::Aggressive,
            vec![hit(HEAVY, P2), END],
        ),
        (
            "target key 3 (slot, forged)",
            forged(vec![
                wild(3, 3, 100, 100, 30, far_kit()),
                player(P1, 1, 3, 1, 50),
                player(P2, 0, 5, 3, 50),
            ]),
            Stance::Aggressive,
            vec![hit(HEAVY, P2), END],
        ),
        (
            "target key 4 (y, forged)",
            forged(vec![
                wild(3, 3, 100, 100, 30, far_kit()),
                player(P1, 0, 5, 3, 50),
                player(P2, 0, 3, 1, 50),
            ]),
            Stance::Aggressive,
            vec![hit(HEAVY, P2), END],
        ),
        (
            "target key 5 (x, forged)",
            forged(vec![
                wild(3, 3, 100, 100, 30, far_kit()),
                player(P1, 0, 5, 3, 50),
                player(P2, 0, 1, 3, 50),
            ]),
            Stance::Aggressive,
            vec![hit(HEAVY, P2), END],
        ),
        (
            "approach tile tie",
            board(
                vec![
                    wild(2, 3, 100, 100, 30, melee_kit()),
                    player(P1, 0, 6, 3, 100),
                ],
                &[(5, 3, Terrain::Blocked)],
            ),
            Stance::Aggressive,
            vec![mv(4, 3, 1), END],
        ),
        (
            "attack tile tie",
            duel(ranged_kit()),
            Stance::Aggressive,
            vec![mv(3, 2, 1), hit(LIGHT, P1), END],
        ),
        (
            "Skittish farthest tile tie",
            board(
                vec![
                    wild(3, 2, 100, 100, 30, ranged_kit()),
                    player(P1, 0, 3, 0, 100),
                ],
                &[],
            ),
            Stance::Skittish,
            vec![mv(2, 2, 1), hit(HEAVY, P1), END],
        ),
        (
            "skill tie",
            three_apart(100, vec![lt(LIGHT, single(1, 3)), lt(LIGHT2, single(1, 3))]),
            Stance::Aggressive,
            vec![hit(LIGHT, P1), END],
        ),
    ];
    for (label, base, stance, want) in ties {
        let spawn = rt::unit_of(&base, WILD).pos;
        for seed in [0_u64, 1, (1_u64 << 53) - 1, u64::MAX] {
            for action_seq in [0_u64, 1, u64::MAX] {
                let mut st = base.clone();
                st.seed = seed;
                st.action_seq = action_seq;
                assert_eq!(
                    plan_of(&st, stance, spawn),
                    want,
                    "{label}: seed {seed:#x}, action_seq {action_seq:#x}"
                );
            }
        }
    }
}

// ===========================================================================
// BT4.2 — Aggressive
// ===========================================================================

/// BT4.2: wild at (3,3) with the melee kit, P1 adjacent at (4,3). `[Heavy, End]` costs 4 from its
/// own tile and the melee aim at (4,3) is 1 away → Heavy (tier first), own tile (cost 0):
/// `[Heavy → P1, End]`.
/// Kills: Light chosen when Heavy is affordable; a pointless Move before attacking.
#[test]
fn an_aggressive_wild_beside_its_target_attacks_heavy_from_its_tile_bt4_2() {
    assert_eq!(
        plan_of(&duel(melee_kit()), Stance::Aggressive, rt::c(3, 3)),
        vec![hit(HEAVY, P1), END]
    );
}

/// BT4.2: wild at (1,3) with the melee kit, P1 at (4,3). The tiles beside P1: (3,3) costs 2 (one
/// stride: `[Move1, Heavy, End]` = 6); (4,2) and (4,4) cost 4 (two strides: 8, refused); (5,3) is
/// behind P1 (cost 6). → `[Move (3,3) ×1, Heavy → P1, End]`.
/// Kills: Light after the stride; `strides: 2` padding; a Move to a 2-stride tile.
#[test]
fn an_aggressive_wild_moves_one_stride_then_attacks_heavy_bt4_2() {
    assert_eq!(
        plan_of(
            &three_apart(100, melee_kit()),
            Stance::Aggressive,
            rt::c(1, 3)
        ),
        vec![mv(3, 3, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.2 / J9: wild at (1,3) with the reach kit (Light r1–3, Heavy melee), P1 at (4,3). A
/// stationary Light is available (P1 is 3 away, `[Light, End]` = 2), but Heavy after one stride
/// to (3,3) is too (6) — the tier is chosen before the tile: `[Move (3,3) ×1, Heavy → P1, End]`.
/// Kills: tile-before-tier (the cheapest tile → `[Light → P1, End]`).
#[test]
fn an_aggressive_wild_prefers_heavy_after_a_stride_to_a_stationary_light_bt4_2() {
    assert_eq!(
        plan_of(
            &three_apart(100, reach_kit()),
            Stance::Aggressive,
            rt::c(1, 3)
        ),
        vec![mv(3, 3, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.2 / J9 (taxed demotion): wild at (3,3) with the ranged kit (both r2–3), P1 ADJACENT at
/// (4,3), so every Move is taxed and nothing hits from the wild's own tile (distance 1 < 2).
/// Heavy after one taxed stride is 3 + 4 = 7 (refused); Light after one taxed stride is 5. The
/// one-stride tiles 2–3 from P1 at cost 1 are (3,2), (2,3), (3,4) → the lowest y, (3,2):
/// `[Move (3,2) ×1, Light → P1, End]`. (Without the tax: Heavy from (3,2).)
/// Kills: the tax ignored (Heavy, halted at pop as 7 AP); the tax judged at the destination.
#[test]
fn the_disengage_tax_demotes_a_one_stride_heavy_to_a_light_bt4_2() {
    assert_eq!(
        plan_of(&duel(ranged_kit()), Stance::Aggressive, rt::c(3, 3)),
        vec![mv(3, 2, 1), hit(LIGHT, P1), END]
    );
}

/// BT4.2: wild at (0,3), melee kit, P1 at (4,3). The only tile beside P1 within 4 stride points is
/// (3,3) at cost 3 → two strides: Heavy 4 + 4 = 8 (refused), Light 4 + 2 = 6 →
/// `[Move (3,3) ×2, Light → P1, End]`.
/// Kills: "Heavy if affordable" read as "Heavy always"; the attack dropped for an approach.
#[test]
fn an_aggressive_wild_spends_two_strides_on_a_light_when_heavy_is_out_of_reach_bt4_2() {
    assert_eq!(
        plan_of(&four_apart(), Stance::Aggressive, rt::c(0, 3)),
        vec![mv(3, 3, 2), hit(LIGHT, P1), END]
    );
}

/// BT4.2: a Caster-origin Heavy is aimed at the caster itself. Wild at (1,3) with Light melee +
/// Heavy 30 = Caster Burst(1) (the ring around the caster), P1 at (4,3). From its own tile P1 is
/// 3 away (not in the ring). One-stride tiles with P1 in the ring: (3,3) at cost 2 (`[Move1, Heavy,
/// End]` = 6); (4,2), (4,4) cost 4 (two strides, 8). → `[Move (3,3) ×1, Heavy 30 → SelfTarget,
/// End]` — the target is the caster (`SelfTarget`), never `Unit(1)`.
/// Kills: a Caster skill emitted as `Unit(T)` (the gate's `AimNotCaster`).
#[test]
fn an_aggressive_wild_aims_a_caster_burst_at_itself_bt4_2() {
    let st = three_apart(
        100,
        vec![lt(LIGHT, single(1, 1)), hv(BURST, caster_burst())],
    );
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(1, 3)),
        vec![mv(3, 3, 1), burst(BURST), END]
    );
}

/// BT4.2 / J10 (approach over Rough): wild at (0,3), melee kit, P1 at (6,3), Rough at (2,3).
/// Nothing beside P1 is within 4 Manhattan → approach: min `(d, cost, y, x)`. (4,3) (d 2) is 4
/// Manhattan away but its only 4-step path crosses the Rough tile: 1 + 2 + 1 + 1 = 5 > 4. (3,3)
/// (d 3) costs 1 + 2 + 1 = 4 → two strides; no other tile in reach has d ≤ 3:
/// `[Move (3,3) ×2, End]`.
/// Kills: reach judged by Manhattan instead of path cost (→ (4,3), refused at pop as TooFar).
#[test]
fn an_aggressive_approach_minimises_distance_by_path_cost_not_manhattan_bt4_2() {
    let st = board(
        vec![
            wild(0, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 6, 3, 100),
        ],
        &[(2, 3, Terrain::Rough)],
    );
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(0, 3)),
        vec![mv(3, 3, 2), END]
    );
}

/// BT4.2 / J4 (approach tie by cost before tile order): wild at (2,3), melee kit, P1 at (6,3),
/// (5,3) Blocked. No attack (beside P1: (5,3) is a wall, (6,2)/(6,4) are 5 away). Nothing reaches
/// d 1; d 2 is reached by (4,3) at cost 2, (5,2) at cost 4 and (5,4) at cost 4. Key `(2, 2, 3, 4)`
/// beats `(2, 4, 2, 5)`: `[Move (4,3) ×1, End]` (cost 2 → ONE stride, J3).
/// Kills: a tile key without cost (→ (5,2), lower y); padded strides.
#[test]
fn an_aggressive_approach_breaks_a_distance_tie_by_path_cost_before_tile_order_bt4_2() {
    let st = board(
        vec![
            wild(2, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 6, 3, 100),
        ],
        &[(5, 3, Terrain::Blocked)],
    );
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(2, 3)),
        vec![mv(4, 3, 1), END]
    );
}

/// BT4.2 / J10 (behind a wall): wild at (3,3), melee kit, P1 at (3,0), row 2 all Blocked. Every
/// tile beside P1 is on the far side (unreachable); every reachable tile is in rows 3..=6 where
/// `d = |3 − x| + y ≥ 3`, equal to 3 only at the wild's own tile (cost 0) → `[End]`.
/// Kills: "always move toward the player" (→ a cost-1 sideways step to (2,3)).
#[test]
fn an_aggressive_wild_no_reachable_tile_brings_closer_stays_put_bt4_2() {
    let wall: Vec<(u8, u8, Terrain)> = (0..7).map(|x| (x, 2, Terrain::Blocked)).collect();
    let st = board(
        vec![
            wild(3, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 3, 0, 100),
        ],
        &wall,
    );
    assert_eq!(plan_of(&st, Stance::Aggressive, rt::c(3, 3)), vec![END]);
}

/// BT4.2 tuning tooth: `end_turn_cost = 1` makes every 6-AP attack plan 7 (the trailing EndTurn is
/// costed as emitted).
/// - Melee, wild (1,3) / P1 (4,3): Heavy after a stride 2 + 4 + 1 = 7 refused; Light after a stride
///   2 + 2 + 1 = 5 → `[Move (3,3) ×1, Light → P1, End]` (DESIGN: Heavy).
/// - J9 board: Heavy after a stride refused; the stationary Light (2 + 1 = 3) is the cheapest
///   Light tile → `[Light → P1, End]`.
/// - Wild (0,3) / P1 (4,3): the two-stride Light 4 + 2 + 1 = 7 refused → approach; (3,3) (d 1,
///   cost 3, `[Move2, End]` = 5) → `[Move (3,3) ×2, End]`.
///
/// Kills: a hard-coded 0 for EndTurn; the tail left out of the costing (halts at pop).
#[test]
fn an_end_turn_cost_of_one_rules_out_every_six_ap_plan_bt4_2() {
    let t = rt::perturb(|t| t.end_turn_cost = 1);
    let aggressive =
        |st: &TacticalState, spawn: Cell| plan(st, WILD, Stance::Aggressive, spawn, &t);
    assert_eq!(
        aggressive(&three_apart(100, melee_kit()), rt::c(1, 3)),
        vec![mv(3, 3, 1), hit(LIGHT, P1), END]
    );
    assert_eq!(
        aggressive(&three_apart(100, reach_kit()), rt::c(1, 3)),
        vec![hit(LIGHT, P1), END]
    );
    assert_eq!(
        aggressive(&four_apart(), rt::c(0, 3)),
        vec![mv(3, 3, 2), END]
    );
}

/// BT4.2 tuning tooth: Heavy after two strides is 4 + 4 = 8 — admitted by `ap_turn = 8`, and by
/// `heavy_cost = 2` (4 + 2 = 6). Wild (0,3) / P1 (4,3): (3,3) at cost 3 (two strides) →
/// `[Move (3,3) ×2, Heavy → P1, End]` (DESIGN: Light). And with `heavy_cost = 2` the taxed
/// ranged duel affords Heavy after one taxed stride (3 + 2 = 5) from (3,2):
/// `[Move (3,2) ×1, Heavy → P1, End]` (DESIGN: Light).
/// Kills: a hard-coded 6-AP budget or Heavy cost of 4.
#[test]
fn eight_ap_or_a_two_ap_heavy_admits_heavy_after_two_strides_bt4_2() {
    let eight = rt::perturb(|t| t.ap_turn = 8);
    let cheap = rt::perturb(|t| t.heavy_cost = 2);
    let want = vec![mv(3, 3, 2), hit(HEAVY, P1), END];
    assert_eq!(
        plan(&four_apart(), WILD, Stance::Aggressive, rt::c(0, 3), &eight),
        want
    );
    assert_eq!(
        plan(&four_apart(), WILD, Stance::Aggressive, rt::c(0, 3), &cheap),
        want
    );
    assert_eq!(
        plan(
            &duel(ranged_kit()),
            WILD,
            Stance::Aggressive,
            rt::c(3, 3),
            &cheap
        ),
        vec![mv(3, 2, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.2 tuning tooth (the stride cap):
/// - `max_strides_per_turn = 1`, wild (0,3) / P1 (4,3): (3,3) costs 3 > 2 points → no attack;
///   approach within 2 points: (2,3) (d 2, cost 2) → `[Move (2,3) ×1, End]` (DESIGN: the
///   two-stride Light).
/// - DESIGN, wild (0,3) / P1 (6,3): nothing beside P1 within 4 → approach to (4,3) (d 2, cost 4):
///   `[Move (4,3) ×2, End]`.
/// - `max_strides_per_turn = 3`, same board: 6 points; (5,3) beside P1 costs 5 → three strides,
///   but an attack after it is 6 + 2 = 8 (refused) → approach to (5,3) (d 1):
///   `[Move (5,3) ×3, End]`.
///
/// Kills: a hard-coded 2-stride reach; strides capped at 2 regardless of the tuning.
#[test]
fn the_stride_cap_bounds_both_attack_tiles_and_the_approach_bt4_2() {
    let one = rt::perturb(|t| t.max_strides_per_turn = 1);
    let three = rt::perturb(|t| t.max_strides_per_turn = 3);
    assert_eq!(
        plan(&four_apart(), WILD, Stance::Aggressive, rt::c(0, 3), &one),
        vec![mv(2, 3, 1), END]
    );
    assert_eq!(
        plan_of(&six_apart(), Stance::Aggressive, rt::c(0, 3)),
        vec![mv(4, 3, 2), END]
    );
    assert_eq!(
        plan(&six_apart(), WILD, Stance::Aggressive, rt::c(0, 3), &three),
        vec![mv(5, 3, 3), END]
    );
}

/// BT4.2 tuning tooth (`disengage_tax = 3`), the ranged duel (P1 adjacent): a taxed one-stride
/// Light is 2 + 3 + 2 = 7 (refused), nothing hits from the wild's own tile, and a taxed two-stride
/// Move is 4 + 3 = 7 (refused). The approach keeps the own tile (d 1, cost 0) against (4,2) /
/// (4,4) (d 1, cost 2) → `[End]` (DESIGN: `[Move (3,2) ×1, Light → P1, End]`).
/// Kills: a hard-coded tax of 1.
#[test]
fn a_disengage_tax_of_three_leaves_a_pinned_ranged_wild_nothing_but_end_turn_bt4_2() {
    let t = rt::perturb(|t| t.disengage_tax = 3);
    assert_eq!(
        plan(
            &duel(ranged_kit()),
            WILD,
            Stance::Aggressive,
            rt::c(3, 3),
            &t
        ),
        vec![END]
    );
}

/// BT4.2 / J13 (within a tier, the FIRST skill in kit order): wild (1,3) with two Lights, both
/// single r1–3, and no Heavy; P1 (4,3) is 3 away, so both hit from the own tile (cost 0,
/// `[Light, End]` = 2) — tier Light, tile the own one, then the first Light listed: kit [10, 12]
/// → `[Light 10 → P1, End]`; kit [12, 10] → `[Light 12 → P1, End]` (kit order, not id order).
/// Kills: the kit index reversed in the key (or the skill id used in its place).
#[test]
fn within_a_tier_the_first_skill_in_kit_order_is_the_one_planned_bt4_2() {
    let both = |first: u32, second: u32| {
        three_apart(100, vec![lt(first, single(1, 3)), lt(second, single(1, 3))])
    };
    assert_eq!(
        plan_of(&both(LIGHT, LIGHT2), Stance::Aggressive, rt::c(1, 3)),
        vec![hit(LIGHT, P1), END]
    );
    assert_eq!(
        plan_of(&both(LIGHT2, LIGHT), Stance::Aggressive, rt::c(1, 3)),
        vec![hit(LIGHT2, P1), END]
    );
}

/// BT4.2 / J13 (the tile is chosen before the skill): wild (1,3), kit [Heavy 20 melee, Heavy 21
/// single r1–3], P1 (4,3). Heavy candidates: Heavy 21 from the own tile (3 away, cost 0,
/// `[Heavy, End]` = 4) and Heavy 20 from (3,3) after one stride (cost 2, 6 AP). Tier Heavy; the
/// tile key `(0, cost, y, x)` takes the own tile; the first Heavy in kit order that hits FROM it
/// is Heavy 21 → `[Heavy 21 → P1, End]`.
/// Kills: the kit index ranked before the tile (→ `[Move (3,3) ×1, Heavy 20 → P1, End]`).
#[test]
fn the_cheapest_attack_tile_is_chosen_before_the_skill_bt4_2() {
    let st = three_apart(100, vec![hv(HEAVY, single(1, 1)), hv(HEAVY2, single(1, 3))]);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(1, 3)),
        vec![hit(HEAVY2, P1), END]
    );
}

/// BT4.2 (the approach is costed as emitted too): `ap_turn = 2` on the six-apart board (wild
/// (0,3), melee kit, P1 (6,3)). Nothing attacks: P1 is out of melee reach of the own tile and a
/// Light after any stride is 2 + 2 = 4 > 2. The approach may only use a Move `[Move, End]`
/// affords: one stride (2 AP), never two (4). Among the cost ≤ 2 tiles the least `d` is (2,3)
/// (d 4, cost 2) → `[Move (2,3) ×1, End]` (DESIGN: `[Move (4,3) ×2, End]`). Through the executor
/// that plan runs with no `PlanHalted`.
/// Kills: the admissibility filter dropped from the approach (→ the 4-AP `[Move (4,3) ×2, End]`,
/// which the gate halts as unaffordable).
#[test]
fn an_approach_only_takes_a_move_the_budget_affords_bt4_2() {
    let t = rt::perturb(|t| t.ap_turn = 2);
    let want = vec![mv(2, 3, 1), END];
    assert_eq!(
        plan(&six_apart(), WILD, Stance::Aggressive, rt::c(0, 3), &t),
        want
    );
    let (out, _battle, hooks) = start_battle(
        six_apart(),
        vec![(WILD, Stance::Aggressive, rt::c(0, 3))],
        &t,
    );
    assert_eq!(hooks.plans(), vec![(WILD, want)]);
    assert!(!halted(&out), "events: {:?}", out.events);
}

/// BT4.2: a FAINTED unit of the other side is no player — `d` is never measured to it. Wild
/// (3,3), melee kit; P1 conscious at (0,0), 6 away (nothing beside it within 4 points → no
/// attack); P2 listed but fainted — 0 HP with state Active, and (a second row) state Fainted —
/// right beside the wild at (4,3). The approach measures `d` to P1 alone: `d = x + y ≥ 2` in
/// reach, `d` 2 at (0,2), (1,1), (2,0), all cost 4 → lowest y: `[Move (2,0) ×2, End]`. (Measured
/// to P2 as well, P2's own tile — no wall, nobody alive stands there — has `d` 0 at cost 1 →
/// `[Move (4,3) ×1, End]`.)
/// Kills: the conscious filter dropped from the players `d` is measured to.
#[test]
fn a_fainted_unit_of_the_other_side_never_draws_the_approach_bt4_2() {
    let base = || {
        board(
            vec![
                wild(3, 3, 100, 100, 30, melee_kit()),
                player(P1, 0, 0, 0, 100),
                player(P2, 1, 4, 3, 100),
            ],
            &[],
        )
    };
    let at_zero_hp = edited(base(), |st| {
        st.unit_mut(P2).expect("P2").cur_hp = 0;
    });
    let fainted = edited(base(), |st| {
        let p2 = st.unit_mut(P2).expect("P2");
        p2.cur_hp = 0;
        p2.state = UnitState::Fainted;
    });
    for (label, st) in [("0 HP, Active", at_zero_hp), ("Fainted", fainted)] {
        assert_eq!(
            plan_of(&st, Stance::Aggressive, rt::c(3, 3)),
            vec![mv(2, 0, 2), END],
            "P2 {label}"
        );
    }
}

// ===========================================================================
// BT4.3 — Territorial (leash 2 from the spawn tile; End when no attack)
// ===========================================================================

/// BT4.3: wild at (5,3), spawn (6,3), melee kit, P1 at (6,1). One-stride Heavy tiles beside P1:
/// (5,1) and (6,2), both cost 2 ((6,0) costs 4). Aggressive takes (5,1) (y 1); Territorial must
/// stay within 2 of (6,3): (5,1) is 3 away (refused), (6,2) is 1 away →
/// `[Move (6,2) ×1, Heavy → P1, End]`.
/// Kills: no leash; the leash measured from the wild's current tile instead of its spawn.
#[test]
fn a_territorial_wild_attacks_from_the_cheapest_attack_tile_inside_its_leash_bt4_3() {
    let st = board(
        vec![
            wild(5, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 6, 1, 100),
        ],
        &[],
    );
    let spawn = rt::c(6, 3);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, spawn),
        vec![mv(5, 1, 1), hit(HEAVY, P1), END]
    );
    assert_eq!(
        plan_of(&st, Stance::Territorial, spawn),
        vec![mv(6, 2, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.3: wild at (4,3), spawn (6,3), melee kit, P1 at (1,3). The tiles beside P1 in reach are
/// (2,3) (cost 2, 4 from the spawn), (1,2) and (1,4) (cost 4, 6 from the spawn) — all outside the
/// leash, and the wild's own tile is 3 from P1. Aggressive: `[Move (2,3) ×1, Heavy → P1, End]`;
/// Territorial: `[End]`.
/// Kills: a leash that only demotes the tier; an approach instead of End.
#[test]
fn a_territorial_wild_with_every_attack_tile_outside_its_leash_ends_its_turn_bt4_3() {
    let st = board(
        vec![
            wild(4, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 1, 3, 100),
        ],
        &[],
    );
    let spawn = rt::c(6, 3);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, spawn),
        vec![mv(2, 3, 1), hit(HEAVY, P1), END]
    );
    assert_eq!(plan_of(&st, Stance::Territorial, spawn), vec![END]);
}

/// BT4.3: attacking from where it stands is not a move — wild at (2,3) (already 4 from its spawn
/// (6,3)), melee kit, P1 adjacent at (1,3): `[Heavy → P1, End]`. (Every other attack tile is
/// outside the leash, so a leash applied to the own tile would plan `[End]`.)
/// Kills: the leash applied to the wild's current tile.
#[test]
fn a_territorial_wild_may_attack_from_where_it_stands_beyond_its_leash_bt4_3() {
    let st = board(
        vec![
            wild(2, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 1, 3, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Territorial, rt::c(6, 3)),
        vec![hit(HEAVY, P1), END]
    );
}

/// BT4.3: no attack → End, never an approach. Wild at (4,3), spawn (6,3), melee kit, P1 at (0,0)
/// (beside-P1 tiles are 6 away). Aggressive approaches: d = x + y ≥ 3 in reach, d 3 at (0,3),
/// (1,2), (2,1), (3,0), all cost 4 → lowest y `[Move (3,0) ×2, End]`; Territorial: `[End]`.
/// Kills: a Territorial approach (even one kept inside the leash).
#[test]
fn a_territorial_wild_never_approaches_bt4_3() {
    let st = board(
        vec![
            wild(4, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 0, 0, 100),
        ],
        &[],
    );
    let spawn = rt::c(6, 3);
    assert_eq!(
        plan_of(&st, Stance::Aggressive, spawn),
        vec![mv(3, 0, 2), END]
    );
    assert_eq!(plan_of(&st, Stance::Territorial, spawn), vec![END]);
}

/// BT4.3 (the leash boundary is inclusive): the board of
/// `a_territorial_wild_attacks_from_the_cheapest_attack_tile_inside_its_leash_bt4_3` (wild (5,3),
/// melee kit, P1 (6,1); the one-stride Heavy tiles beside P1 are (5,1) and (6,2), both cost 2;
/// (6,0) costs 4; the own tile is 3 from P1) with the spawn moved:
/// - spawn (6,4): (6,2) is EXACTLY 2 from it — inside the leash — and (5,1) / (6,0) are 4 →
///   `[Move (6,2) ×1, Heavy → P1, End]`;
/// - spawn (6,5): (6,2) is 3 from it, (5,1) and (6,0) 5 → no attack tile → `[End]`.
///
/// Kills: `≤ 2` read as `< 2` (→ `[End]` at spawn (6,4)); a leash of 3 (→ the attack at (6,5)).
#[test]
fn the_leash_admits_a_tile_exactly_two_from_the_spawn_bt4_3() {
    let st = board(
        vec![
            wild(5, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 6, 1, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Territorial, rt::c(6, 4)),
        vec![mv(6, 2, 1), hit(HEAVY, P1), END]
    );
    assert_eq!(plan_of(&st, Stance::Territorial, rt::c(6, 5)), vec![END]);
}

/// BT4.3 (Guard): through the REAL executor — the wild of the leash-blocked board (levelled speed
/// 80) acts before P1 (speed 30); its plan is `[End]`, which ends the turn committed with 6 AP
/// unspent and no attack → Guard: `TurnEnded{11, guard: true, committed: true}`, the wild's `guard`
/// flag is set, and it never moved.
/// Kills: a Territorial plan that moves (no Guard-holding stillness) or attacks (no Guard).
#[test]
fn a_territorial_wild_that_cannot_attack_ends_its_turn_guarded_through_the_executor_bt4_3() {
    let st = board(
        vec![
            wild(4, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 1, 3, 100),
        ],
        &[],
    );
    let t = rt::design();
    let wilds = vec![(WILD, Stance::Territorial, rt::c(6, 3))];
    let (out, battle, hooks) = start_battle(st, wilds, &t);
    assert_eq!(hooks.plans(), vec![(WILD, vec![END])]);
    assert!(!halted(&out), "events: {:?}", out.events);
    assert!(
        out.events
            .contains(&EventPayload::TurnEnded(TurnEndedEvent {
                unit: WILD,
                guard: true,
                committed: true,
            })),
        "events: {:?}",
        out.events
    );
    let w = rt::unit_of(&battle.state, WILD);
    assert!(w.guard, "the Territorial wild holds Guard after its turn");
    assert_eq!(w.pos, rt::c(4, 3));
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, EventPayload::Moved(m) if m.unit == WILD)));
}

// ===========================================================================
// BT4.4 — Skittish (Heavy only; farthest attack tile; kite within heavy range_max + 2)
// ===========================================================================

/// BT4.4: wild at (3,3) with the pinned kit (Light melee, Heavy r2–3), P1 ADJACENT at (4,3). The
/// Light could hit P1 from here; the Heavy cannot (distance 1) and a taxed stride + Heavy is 7 →
/// no Heavy attack → kite, band = 3 + 2 = 5. Every tile with x ≤ 3 has d = (its distance from the
/// wild) + 1, so the farthest in reach (4 points, `[Move2, End]` taxed = 5) is d 5 at (0,2),
/// (0,4), (1,1), (1,5), (2,0), (2,6), all cost 4 → lowest y `[Move (2,0) ×2, End]`.
/// Kills: a Skittish Light attack (`[Light → P1, End]`).
#[test]
fn a_skittish_wild_never_attacks_with_a_light_bt4_4() {
    assert_eq!(
        plan_of(&duel(pinned_kit()), Stance::Skittish, rt::c(3, 3)),
        vec![mv(2, 0, 2), END]
    );
}

/// BT4.4: wild at (3,2) with the ranged kit (both r2–3), P1 at (3,0) (2 away, untaxed). Heavy
/// tiles (one stride, 2–3 from P1): its own (d 2), (2,1) and (4,1) (d 2, cost 2), (2,2), (4,2),
/// (3,3) (d 3, cost 1). Farthest d 3, all cost 1 → `(y, x)` → (2,2):
/// `[Move (2,2) ×1, Heavy → P1, End]`. Aggressive on the same board attacks from its tile.
/// Kills: the nearest / cheapest attack tile (Aggressive's rule) for Skittish.
#[test]
fn a_skittish_wild_attacks_from_the_heavy_tile_farthest_from_the_nearest_player_bt4_4() {
    let st = board(
        vec![
            wild(3, 2, 100, 100, 30, ranged_kit()),
            player(P1, 0, 3, 0, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(3, 2)),
        vec![mv(2, 2, 1), hit(HEAVY, P1), END]
    );
    assert_eq!(
        plan_of(&st, Stance::Aggressive, rt::c(3, 2)),
        vec![hit(HEAVY, P1), END]
    );
}

/// BT4.4: the same board with (2,2) Rough: the d-3 Heavy tiles are (4,2) cost 1, (3,3) cost 1 and
/// (2,2) cost 2 → `(Reverse 3, 1, 2, 4)` → (4,2): `[Move (4,2) ×1, Heavy → P1, End]`.
/// Kills: a farthest-tile key without path cost (→ (2,2)).
#[test]
fn a_skittish_wild_breaks_a_farthest_tile_tie_by_path_cost_bt4_4() {
    let st = board(
        vec![
            wild(3, 2, 100, 100, 30, ranged_kit()),
            player(P1, 0, 3, 0, 100),
        ],
        &[(2, 2, Terrain::Rough)],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(3, 2)),
        vec![mv(4, 2, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.4 (kite within band): wild at (0,2), melee kit (band 1 + 2 = 3), P1 at (0,0), (0,1)
/// Blocked. Beside P1 only (1,0) is open, at cost 3 (two strides + Heavy = 8) → no Heavy → kite.
/// d = x + y; in band the farthest is d 3: (0,3) cost 1, (1,2) cost 1, (2,1) cost 3 →
/// `(Reverse 3, 1, 2, 1)` → (1,2): `[Move (1,2) ×1, End]` (the wild's own d 2 is not the best).
/// Kills: a kite that maximises d without the band; one that never leaves an in-band tile.
#[test]
fn a_skittish_wild_kites_to_the_farthest_tile_inside_its_band_bt4_4() {
    let st = board(
        vec![
            wild(0, 2, 100, 100, 30, melee_kit()),
            player(P1, 0, 0, 0, 100),
        ],
        &[(0, 1, Terrain::Blocked)],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(0, 2)),
        vec![mv(1, 2, 1), END]
    );
}

/// BT4.4 (moves only on a strict improvement): wild at (0,3), melee kit (band 3), P1 at (0,0),
/// (0,2) Rough. Beside P1: (0,1) costs 3 (through the Rough tile), (1,0) costs 4 → no one-stride
/// Heavy → kite. The wild's own tile already has d 3 = the band; the other d-3 tiles are (1,2)
/// (cost 2) and (2,1) (cost 4) → its own tile (cost 0) wins: `[End]`.
/// Kills: a kite key without cost (→ (2,1), lower y); a kite ignoring the band (→ a d-7 tile).
#[test]
fn a_skittish_wild_already_at_the_edge_of_its_band_holds_its_tile_bt4_4() {
    let st = board(
        vec![
            wild(0, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 0, 0, 100),
        ],
        &[(0, 2, Terrain::Rough)],
    );
    assert_eq!(plan_of(&st, Stance::Skittish, rt::c(0, 3)), vec![END]);
}

/// BT4.4: wild at (3,3), melee kit (band 3), P1 at (0,0): its own d 6 is out of band and nothing
/// beside P1 is in reach. In-band tiles in reach: d 2 at (0,2), (1,1), (2,0) (cost 4) and d 3 at
/// (0,3), (1,2), (2,1), (3,0) (cost 3) → the farthest in band, lowest y: (3,0), cost 3 → two
/// strides: `[Move (3,0) ×2, End]`.
/// Kills: a kite that only runs away (d grows past the band); staying out of band.
#[test]
fn a_skittish_wild_outside_its_band_moves_back_into_it_bt4_4() {
    let st = board(
        vec![
            wild(3, 3, 100, 100, 30, melee_kit()),
            player(P1, 0, 0, 0, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(3, 3)),
        vec![mv(3, 0, 2), END]
    );
}

/// BT4.4 / J5: wild at (6,6), melee kit (band 3), P1 at (0,0): every tile in reach has d ≥ 8 >
/// band → the Aggressive approach: d 8 at (2,6), (3,5), (4,4), (5,3), (6,2), all cost 4 → lowest
/// y `[Move (6,2) ×2, End]`.
/// Kills: an out-of-band Skittish that idles (`[End]`) or keeps fleeing.
#[test]
fn a_skittish_wild_with_no_band_tile_in_reach_approaches_bt4_4() {
    let st = board(
        vec![
            wild(6, 6, 100, 100, 30, melee_kit()),
            player(P1, 0, 0, 0, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(6, 6)),
        vec![mv(6, 2, 2), END]
    );
}

/// BT4.4 / J6: a kit with no Heavy (Light melee + Light r1–3) never attacks and kites with band
/// 0 + 2 = 2. Wild at (1,0), P1 adjacent at (0,0) (taxed: one stride 3, two 5). d = x + y; the
/// farthest in band is d 2: (2,0) cost 1, (1,1) cost 1, (0,2) cost 3 → `[Move (2,0) ×1, End]`.
/// Kills: a Light attack; a band taken from a Light's range (3 + 2 → a d-5 tile).
#[test]
fn a_skittish_wild_without_a_heavy_never_attacks_and_kites_within_two_bt4_4() {
    let st = board(
        vec![
            wild(
                1,
                0,
                100,
                100,
                30,
                vec![lt(LIGHT, single(1, 1)), lt(12, single(1, 3))],
            ),
            player(P1, 0, 0, 0, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(1, 0)),
        vec![mv(2, 0, 1), END]
    );
}

/// BT4.4 (the band is the GREATEST Heavy `range_max` + 2): Skittish wild (3,3), P1 (0,0), 6 away
/// and untaxed. Kit Light 10 r1, Heavy 20 single r1, Heavy 21 single r1–3: no Heavy reaches P1
/// (a one-stride tile is ≥ 4 from it; two strides + Heavy is 8) → kite with band max(1, 3) + 2 =
/// 5. In reach (4 points) `d = x + y`, the farthest in band is `d` 5: (2,3) and (3,2) cost 1,
/// (1,4) and (4,1) cost 3 ((0,5) and (5,0) are 5 points away) → `(Reverse 5, 1, y 2)` → (3,2):
/// `[Move (3,2) ×1, End]` — and the same with the two Heavies swapped in the kit. (A band of 3 —
/// the least Heavy range, or the first or last Heavy alone — would kite to `d` 3: (0,3), (1,2),
/// (2,1), (3,0), all cost 3 → `[Move (3,0) ×2, End]`.)
/// Kills: `max` → `min`; the first (or the last) Heavy's range instead of the greatest.
#[test]
fn the_kite_band_is_the_greatest_heavy_range_plus_two_bt4_4() {
    let want = vec![mv(3, 2, 1), END];
    for heavies in [
        [hv(HEAVY, single(1, 1)), hv(HEAVY2, single(1, 3))],
        [hv(HEAVY2, single(1, 3)), hv(HEAVY, single(1, 1))],
    ] {
        let mut skills = vec![lt(LIGHT, single(1, 1))];
        skills.extend(heavies);
        let st = board(
            vec![wild(3, 3, 100, 100, 30, skills), player(P1, 0, 0, 0, 100)],
            &[],
        );
        assert_eq!(plan_of(&st, Stance::Skittish, rt::c(3, 3)), want);
    }
}

/// BT4.4 (the farthest tile is measured to the NEAREST player, not to the target): wild (3,3),
/// the pinned kit (Light melee, Heavy 20 single r2–3); P1 (3,1) 2 away and P2 (1,4) 3 away, so
/// untaxed and the target is P1 (nearer). Heavy tiles for P1 in one stride (2–3 from (3,1)): the
/// own (3,3), (2,3), (4,3), (3,4), (2,2), (4,2). `d` to the nearest player (P1 | P2): (3,3) 2|3,
/// (2,3) 3|2, (4,3) 3|4, (3,4) 3|2, (2,2) 2|3, (4,2) 2|5 → only (4,3) reaches `d` 3, cost 1 →
/// `[Move (4,3) ×1, Heavy → P1, End]` (re-derived; the red-team's reference agrees). Measured to
/// the target P1 alone, (2,3), (4,3) and (3,4) would tie at 3 → (2,3).
/// Kills: the farthest-tile primary measured to the target instead of the nearest player.
#[test]
fn the_skittish_attack_tile_is_farthest_from_the_nearest_player_not_the_target_bt4_4() {
    let st = board(
        vec![
            wild(3, 3, 100, 100, 30, pinned_kit()),
            player(P1, 0, 3, 1, 100),
            player(P2, 1, 1, 4, 100),
        ],
        &[],
    );
    assert_eq!(
        plan_of(&st, Stance::Skittish, rt::c(3, 3)),
        vec![mv(4, 3, 1), hit(HEAVY, P1), END]
    );
}

// ===========================================================================
// BT4.5 — Exhausted (cur_hp × 4 < max_hp): never moves, attacks from its tile, else End
// ===========================================================================

/// BT4.5: `is_exhausted(cur, max)` is `cur × 4 < max`, computed without overflow.
/// (16384, 65535): 65 536 is not below 65 535 → false (a u16 product wraps to 0 → "true", or traps);
/// (16383, 65535): 65 532 < 65 535 → true; (25, 100): 100 → false; (24, 100): 96 → true;
/// (0, 0): 0 < 0 → false; (1, 4): 4 < 4 → false; (1, 5): 4 < 5 → true (`cur < max / 4` says
/// false); (1, 7): true; (2, 8): false; (0, 1): true; (65535, 65535): false.
/// Kills: a u16 product; `<=`; integer division of max_hp.
#[test]
fn is_exhausted_is_four_times_hp_below_max_computed_without_overflow_bt4_5() {
    for (cur, max, want) in [
        (16_384_u16, 65_535_u16, false),
        (16_383, 65_535, true),
        (25, 100, false),
        (24, 100, true),
        (0, 0, false),
        (1, 4, false),
        (1, 5, true),
        (1, 7, true),
        (2, 8, false),
        (0, 1, true),
        (65_535, 65_535, false),
        (100, 100, false),
    ] {
        assert_eq!(is_exhausted(cur, max), want, "is_exhausted({cur}, {max})");
    }
}

/// BT4.5: the J9 board with the wild at 24/100 HP (exhausted) — the Heavy is one stride away
/// (Aggressive at full HP plans `[Move (3,3) ×1, Heavy, End]`), but an Exhausted wild of EVERY
/// stance never moves: from its own tile only the Light reaches P1 (3 away) → `[Light → P1, End]`.
/// (The override is universal: the Skittish Heavy-only rule does not apply.)
/// Kills: Exhausted checked after the stance; a Move before the attack; Skittish refusing the Light.
#[test]
fn an_exhausted_wild_of_every_stance_attacks_from_its_tile_and_never_moves_bt4_5() {
    let st = three_apart(24, reach_kit());
    for stance in STANCES {
        assert_eq!(
            plan_of(&st, stance, rt::c(1, 3)),
            vec![hit(LIGHT, P1), END],
            "{stance:?}"
        );
    }
}

/// BT4.5: melee kit, wild at (1,3) at 24/100 HP, P1 at (4,3): nothing reaches P1 from the wild's
/// own tile → `[End]` for every stance (at full HP the Aggressive and Skittish wilds would move
/// and attack).
/// Kills: an Exhausted approach; an Exhausted Move-then-attack.
#[test]
fn an_exhausted_wild_with_nothing_in_range_ends_its_turn_bt4_5() {
    let st = three_apart(24, melee_kit());
    for stance in STANCES {
        assert_eq!(plan_of(&st, stance, rt::c(1, 3)), vec![END], "{stance:?}");
    }
    assert_eq!(
        plan_of(
            &three_apart(100, melee_kit()),
            Stance::Aggressive,
            rt::c(1, 3)
        ),
        vec![mv(3, 3, 1), hit(HEAVY, P1), END]
    );
}

/// BT4.5: "attacks from its tile" picks Heavy when affordable, else Light. Wild at (3,3) at 24 HP,
/// P1 adjacent at (4,3):
/// - melee kit → `[Heavy → P1, End]` for every stance;
/// - melee kit, `heavy_cost = 7` (`[Heavy, End]` = 7 > 6) → `[Light → P1, End]`;
/// - pinned kit (Heavy r2–3 cannot hit an adjacent unit) → `[Light → P1, End]` for every stance,
///   Skittish included (at full HP the Skittish wild kites instead).
///
/// Kills: Exhausted always Light / always Heavy; the Heavy cost hard-coded.
#[test]
fn an_exhausted_wild_attacks_heavy_when_affordable_else_light_bt4_5() {
    let tired = |skills: Vec<SkillTactics>| with_wild(duel(skills), |w| w.cur_hp = 24);
    let spawn = rt::c(3, 3);
    for stance in STANCES {
        assert_eq!(
            plan_of(&tired(melee_kit()), stance, spawn),
            vec![hit(HEAVY, P1), END],
            "{stance:?} melee"
        );
        assert_eq!(
            plan_of(&tired(pinned_kit()), stance, spawn),
            vec![hit(LIGHT, P1), END],
            "{stance:?} pinned"
        );
    }
    let dear = rt::perturb(|t| t.heavy_cost = 7);
    assert_eq!(
        plan(&tired(melee_kit()), WILD, Stance::Aggressive, spawn, &dear),
        vec![hit(LIGHT, P1), END]
    );
    assert_eq!(
        plan_of(&duel(pinned_kit()), Stance::Skittish, spawn),
        vec![mv(2, 0, 2), END]
    );
}

/// BT4.5: the boundary is strict and reads the kit's max HP. J9 board:
/// - 25/100 (100 is not below 100) → not exhausted → `[Move (3,3) ×1, Heavy → P1, End]`;
/// - 24/100 → exhausted → `[Light → P1, End]`;
/// - 2/8 (8 is not below 8) → not exhausted → the Heavy plan; 1/8 (4 < 8) → `[Light → P1, End]`.
///
/// Kills: `<=`; a hard-coded max HP of 100; HP percent rounding.
#[test]
fn the_exhausted_boundary_is_strict_and_reads_max_hp_from_the_kit_bt4_5() {
    let moved = vec![mv(3, 3, 1), hit(HEAVY, P1), END];
    let still = vec![hit(LIGHT, P1), END];
    let at = |max_hp: u16, hp: u16| {
        board(
            vec![
                wild(1, 3, max_hp, hp, 30, reach_kit()),
                player(P1, 0, 4, 3, 100),
            ],
            &[],
        )
    };
    for (max_hp, hp, want) in [
        (100_u16, 25_u16, &moved),
        (100, 24, &still),
        (8, 2, &moved),
        (8, 1, &still),
    ] {
        assert_eq!(
            &plan_of(&at(max_hp, hp), Stance::Aggressive, rt::c(1, 3)),
            want,
            "{hp}/{max_hp}"
        );
    }
}

// ===========================================================================
// BT4.6 — only Move / Skill / EndTurn, executable, total on hostile states
// ===========================================================================

/// BT4.6 (totality): every hostile state plans exactly `[End]` for every stance, never a panic.
/// The untouched board (melee duel) plans `[Heavy → P1, End]`, so each `[End]` below is the guard's
/// doing: an unknown unit; the battle decided (A won / fled); the wild fainted (0 HP; state
/// Fainted) or recruited; a duplicated unit id (a player's, the wild's); the wild off the board
/// (x = width; far off); an unusable tuning (`ap_turn`, `guard_den`, `flank_den` 0); a wild that
/// fails `validate_unit` (defence 0; HP above max); no conscious player (fainted, recruited,
/// none at all).
/// Kills: any guard missing (a panic, a plan for a dead / foreign / doubled unit).
#[test]
fn hostile_states_plan_exactly_end_turn_for_every_stance_bt4_6() {
    let base = || duel(melee_kit());
    let spawn = rt::c(3, 3);
    let t = rt::design();
    assert_eq!(
        plan(&base(), WILD, Stance::Aggressive, spawn, &t),
        vec![hit(HEAVY, P1), END]
    );
    let rows = [
        ("unknown unit", base(), 99, t.clone()),
        (
            "battle over: A won",
            edited(base(), |st| st.outcome = BattleOutcome::SideAWins),
            WILD,
            t.clone(),
        ),
        (
            "battle over: fled",
            edited(base(), |st| st.outcome = BattleOutcome::Fled),
            WILD,
            t.clone(),
        ),
        (
            "wild at 0 HP",
            with_wild(base(), |w| w.cur_hp = 0),
            WILD,
            t.clone(),
        ),
        (
            "wild Fainted",
            with_wild(base(), |w| w.state = UnitState::Fainted),
            WILD,
            t.clone(),
        ),
        (
            "wild Recruited",
            with_wild(base(), |w| w.state = UnitState::Recruited),
            WILD,
            t.clone(),
        ),
        (
            "player id twice",
            edited(base(), |st| {
                let mut twin = st.unit(P1).expect("P1").clone();
                twin.pos = rt::c(0, 6);
                st.units.push(twin);
            }),
            WILD,
            t.clone(),
        ),
        (
            "wild id twice",
            edited(base(), |st| {
                let mut twin = st.unit(WILD).expect("the wild").clone();
                twin.pos = rt::c(6, 6);
                st.units.push(twin);
            }),
            WILD,
            t.clone(),
        ),
        (
            "wild at x = width",
            with_wild(base(), |w| w.pos = rt::c(7, 3)),
            WILD,
            t.clone(),
        ),
        (
            "wild far off the board",
            with_wild(base(), |w| w.pos = rt::c(200, 200)),
            WILD,
            t.clone(),
        ),
        ("ap_turn 0", base(), WILD, rt::perturb(|t| t.ap_turn = 0)),
        (
            "guard_den 0",
            base(),
            WILD,
            rt::perturb(|t| t.guard_den = 0),
        ),
        (
            "flank_den 0",
            base(),
            WILD,
            rt::perturb(|t| t.flank_den = 0),
        ),
        (
            "wild defence 0",
            with_wild(base(), |w| w.kit.stats.defense = 0),
            WILD,
            t.clone(),
        ),
        (
            "wild HP above max",
            with_wild(base(), |w| w.cur_hp = 101),
            WILD,
            t.clone(),
        ),
        (
            "the only player fainted",
            edited(base(), |st| {
                st.unit_mut(P1).expect("P1").cur_hp = 0;
            }),
            WILD,
            t.clone(),
        ),
        (
            "the only player recruited",
            edited(base(), |st| {
                st.unit_mut(P1).expect("P1").state = UnitState::Recruited;
            }),
            WILD,
            t.clone(),
        ),
        (
            "no players at all",
            edited(base(), |st| st.units.retain(|u| u.side == Side::B)),
            WILD,
            t.clone(),
        ),
    ];
    for (label, st, unit, tuning) in rows {
        for stance in STANCES {
            assert_eq!(
                plan(&st, unit, stance, spawn, &tuning),
                vec![END],
                "{label} ({stance:?})"
            );
        }
    }
}

/// BT4.6 (totality, plannable rows — each answer derived):
/// - `max_strides_per_turn = 0` (no Move at all; attacks from the own tile remain): melee duel →
///   `[Heavy → P1, End]`; J9 board → `[Light → P1, End]`; melee three apart → `[End]`.
/// - `max_strides_per_turn = 255` (a wider reach, the same costs): J9 →
///   `[Move (3,3) ×1, Heavy → P1, End]`.
/// - base speed 0 (stride 2): J9 → the same plan.
/// - Heavy single r1–255, wild (3,3) / P1 (0,0) (6 away): `[Heavy → P1, End]`.
/// - Skittish, Heavy single r200–255 (never in range), wild (3,3) / P1 (0,0): band 255 + 2 = 257
///   (u16; a u8 band wraps to 1) holds every tile → the farthest, d = x + y = 10 at (6,4), (5,5),
///   (4,6), cost 4 → `[Move (6,4) ×2, End]`.
/// - a Line-shaped Heavy (`target_set` refuses it), melee duel → the Light: `[Light → P1, End]`.
/// - no skills: melee duel → approach, own tile d 1 wins → `[End]`; three apart → (3,3) (d 1,
///   cost 2) → `[Move (3,3) ×1, End]`.
/// - two players on one tile (forged) beside the wild: target key ties at distance 1 and 100 HP,
///   slot 0 → P1; the melee aim at (4,3) hits both, P1 included → `[Heavy → P1, End]`.
///
/// Kills: a panic or a refusal on a legal-but-odd state; strides `max + 1` / u8 band overflow.
#[test]
fn hostile_but_plannable_states_plan_their_derived_answer_bt4_6() {
    let none = rt::perturb(|t| t.max_strides_per_turn = 0);
    let wide = rt::perturb(|t| t.max_strides_per_turn = 255);
    let t = rt::design();
    let j9 = vec![mv(3, 3, 1), hit(HEAVY, P1), END];
    let far_player = |skills: Vec<SkillTactics>| {
        board(
            vec![wild(3, 3, 100, 100, 30, skills), player(P1, 0, 0, 0, 100)],
            &[],
        )
    };
    let rows = [
        (
            "no strides, duel",
            duel(melee_kit()),
            Stance::Aggressive,
            none.clone(),
            vec![hit(HEAVY, P1), END],
        ),
        (
            "no strides, J9",
            three_apart(100, reach_kit()),
            Stance::Aggressive,
            none.clone(),
            vec![hit(LIGHT, P1), END],
        ),
        (
            "no strides, melee three apart",
            three_apart(100, melee_kit()),
            Stance::Aggressive,
            none,
            vec![END],
        ),
        (
            "255 strides, J9",
            three_apart(100, reach_kit()),
            Stance::Aggressive,
            wide,
            j9.clone(),
        ),
        (
            "base speed 0, J9",
            board(
                vec![
                    wild(1, 3, 100, 100, 0, reach_kit()),
                    player(P1, 0, 4, 3, 100),
                ],
                &[],
            ),
            Stance::Aggressive,
            t.clone(),
            j9,
        ),
        (
            "Heavy range 1..=255",
            far_player(vec![lt(LIGHT, single(1, 1)), hv(HEAVY, single(1, 255))]),
            Stance::Aggressive,
            t.clone(),
            vec![hit(HEAVY, P1), END],
        ),
        (
            "Skittish, Heavy range 200..=255",
            far_player(vec![lt(LIGHT, single(1, 1)), hv(HEAVY, single(200, 255))]),
            Stance::Skittish,
            t.clone(),
            vec![mv(6, 4, 2), END],
        ),
        (
            "Line-shaped Heavy, duel",
            duel(vec![lt(LIGHT, single(1, 1)), hv(HEAVY, line())]),
            Stance::Aggressive,
            t.clone(),
            vec![hit(LIGHT, P1), END],
        ),
        (
            "no skills, duel",
            duel(Vec::new()),
            Stance::Aggressive,
            t.clone(),
            vec![END],
        ),
        (
            "no skills, three apart",
            three_apart(100, Vec::new()),
            Stance::Aggressive,
            t.clone(),
            vec![mv(3, 3, 1), END],
        ),
        (
            "two players on one tile",
            forged(vec![
                wild(3, 3, 100, 100, 30, melee_kit()),
                player(P1, 0, 4, 3, 100),
                player(P2, 1, 4, 3, 100),
            ]),
            Stance::Aggressive,
            t,
            vec![hit(HEAVY, P1), END],
        ),
    ];
    for (label, st, stance, tuning, want) in rows {
        let spawn = rt::unit_of(&st, WILD).pos;
        assert_eq!(plan(&st, WILD, stance, spawn, &tuning), want, "{label}");
    }
}

/// BT4.6: the J9 plan runs through the REAL executor (`TacticalBattle::start`): the wild (speed
/// 80) acts before P1 (speed 30); `plan_ai` answers `[Move (3,3) ×1, Heavy → P1, End]`, which
/// executes with no `PlanHalted`: `Moved{11, (1,3) → (3,3), 2 tiles}`, an `Executed` of skill 20 by
/// 11, then `TurnEnded{11, guard: false, committed: true}` (it attacked); the wild ends on (3,3).
/// Kills: a plan the gate refuses (padded strides, a re-implemented range or cost rule).
#[test]
fn a_planned_move_and_attack_executes_through_the_real_executor_bt4_6() {
    let t = rt::design();
    let (out, battle, hooks) = start_battle(
        three_apart(100, reach_kit()),
        vec![(WILD, Stance::Aggressive, rt::c(1, 3))],
        &t,
    );
    assert_eq!(
        hooks.plans(),
        vec![(WILD, vec![mv(3, 3, 1), hit(HEAVY, P1), END])]
    );
    assert!(!halted(&out), "events: {:?}", out.events);
    assert!(
        out.events.contains(&EventPayload::Moved(MovedEvent {
            unit: WILD,
            from_x: 1,
            from_y: 3,
            to_x: 3,
            to_y: 3,
            tiles: 2,
        })),
        "events: {:?}",
        out.events
    );
    assert!(out.events.iter().any(
        |e| matches!(e, EventPayload::Executed(x) if x.attacker == WILD && x.skill_id == HEAVY)
    ));
    assert!(out
        .events
        .contains(&EventPayload::TurnEnded(TurnEndedEvent {
            unit: WILD,
            guard: false,
            committed: true,
        })));
    assert_eq!(rt::unit_of(&battle.state, WILD).pos, rt::c(3, 3));
}

/// BT4.6 (the gate's `validate_unit` runs on EVERY unit of the target set, so the planner's
/// does too):
/// - forged, units listed wild first: the wild (3,3) carries one Heavy, the `diamond_all`
///   (Diamond(1) r1–2, friendly fire `All`); P1 (5,3) is valid, P2 (5,4) has defence 0 and stands
///   inside the diamond around P1. Every aim — at P1 or at P2 — puts P2 in the set → no attack.
///   The approach (untaxed): `d` 1 at (4,3) cost 1, (4,4) cost 2, (5,2) cost 3, (5,5) cost 4 →
///   `[Move (4,3) ×1, End]`; Territorial `[End]`.
/// - the melee duel with its ONLY player invalid (defence 0; HP 101 of 100): no attack is
///   plannable. Aggressive keeps its tile (`d` 1, cost 0) → `[End]`; Territorial `[End]`;
///   Skittish kites (band 1 + 2 = 3, taxed: one stride 3, two 5): `d` 3 at (3,1), (2,2), (1,3),
///   (2,4), (3,5) cost 2, the other `d`-3 tiles cost 4 → lowest y `[Move (3,1) ×1, End]`.
///
/// Kills: the target-set check dropped or looking up the wrong unit (→ an attack the gate halts
/// as `BadUnit`: `[Heavy → P1, End]`).
#[test]
fn an_attack_whose_target_set_holds_an_invalid_unit_is_never_planned_bt4_6() {
    let collateral = edited(
        forged(vec![
            wild(3, 3, 100, 100, 30, vec![hv(HEAVY, diamond_all())]),
            player(P1, 0, 5, 3, 100),
            player(P2, 1, 5, 4, 100),
        ]),
        |st| st.unit_mut(P2).expect("P2").kit.stats.defense = 0,
    );
    assert_eq!(
        plan_of(&collateral, Stance::Aggressive, rt::c(3, 3)),
        vec![mv(4, 3, 1), END]
    );
    assert_eq!(
        plan_of(&collateral, Stance::Territorial, rt::c(3, 3)),
        vec![END]
    );
    let soft = edited(duel(melee_kit()), |st| {
        st.unit_mut(P1).expect("P1").kit.stats.defense = 0;
    });
    let over = edited(duel(melee_kit()), |st| {
        st.unit_mut(P1).expect("P1").cur_hp = 101;
    });
    for (label, st) in [("P1 defence 0", soft), ("P1 HP above max", over)] {
        for (stance, want) in [
            (Stance::Aggressive, vec![END]),
            (Stance::Territorial, vec![END]),
            (Stance::Skittish, vec![mv(3, 1, 1), END]),
        ] {
            assert_eq!(
                plan_of(&st, stance, rt::c(3, 3)),
                want,
                "{label} ({stance:?})"
            );
        }
    }
}

/// BT4.6 / J11 (never self-hit), a Caster-centred AoE: the wild's only skill is a Heavy
/// Diamond(1) around ITSELF (range 0, friendly fire `All`), so every cast holds the wild and none
/// is plannable. Melee-duel geometry (wild (3,3), P1 adjacent at (4,3)): Aggressive keeps its tile
/// (`d` 1, cost 0) → `[End]`; Territorial `[End]`; Skittish kites (band 0 + 2 = 2, taxed): `d` 2
/// at (3,2), (2,3), (3,4) cost 1 → `[Move (3,2) ×1, End]`. Exhausted (24 HP) — the self-KO case J11
/// names — `[End]` for every stance.
/// Kills: the `unit ∉ ids` term dropped (→ `[Heavy 20 → SelfTarget, End]`).
#[test]
fn a_caster_aoe_that_holds_the_wild_itself_is_never_planned_bt4_6() {
    let st = duel(vec![hv(HEAVY, caster_diamond_all())]);
    for (stance, want) in [
        (Stance::Aggressive, vec![END]),
        (Stance::Territorial, vec![END]),
        (Stance::Skittish, vec![mv(3, 2, 1), END]),
    ] {
        assert_eq!(plan_of(&st, stance, rt::c(3, 3)), want, "{stance:?}");
    }
    let tired = with_wild(st, |w| w.cur_hp = 24);
    for stance in STANCES {
        assert_eq!(
            plan_of(&tired, stance, rt::c(3, 3)),
            vec![END],
            "Exhausted {stance:?}"
        );
    }
}

/// BT4.6 / J11, a targeted AoE: the `diamond_all` as the wild's only skill — a Light, Diamond(1)
/// r1–2, friendly fire `All` — with the wild at (3,3) and P1 adjacent at (4,3). From the own tile
/// the diamond around P1 holds the wild → excluded; a tile EXACTLY 2 from P1 keeps the wild outside
/// it. Taxed: a Light after one stride is 3 + 2 = 5 (after two, 7: refused); the cost-1 tiles 2
/// from P1 are (3,2), (2,3), (3,4) → `(0, 1, y 2)` → `[Move (3,2) ×1, Light → P1, End]`, for
/// Aggressive and for Territorial (spawn (3,3); (3,2) is 1 from it). (Re-derived; the red-team's
/// reference agrees.)
/// Kills: the `unit ∉ ids` term dropped (→ the stationary `[Light → P1, End]`).
#[test]
fn a_targeted_aoe_is_cast_only_from_a_tile_outside_its_own_blast_bt4_6() {
    let st = duel(vec![lt(LIGHT, diamond_all())]);
    for stance in [Stance::Aggressive, Stance::Territorial] {
        assert_eq!(
            plan_of(&st, stance, rt::c(3, 3)),
            vec![mv(3, 2, 1), hit(LIGHT, P1), END],
            "{stance:?}"
        );
    }
}

/// BT4.6: the wild off the board (x = 7 on the 7-wide board) carrying the RANGED kit (both r2–3):
/// P1 at (4,3) is 3 away, so a cast from the off-board tile WOULD reach it — only the off-board
/// guard (`disengage_taxed` refuses the start tile) stops it: `[End]` for every stance. (The
/// round-1 row uses the melee kit, which plans `[End]` from there for another reason.)
/// Kills: the off-board refusal waived (read as "untaxed") → `[Heavy → P1, End]`.
#[test]
fn an_off_board_wild_with_a_target_in_range_ends_its_turn_bt4_6() {
    let st = with_wild(duel(ranged_kit()), |w| w.pos = rt::c(7, 3));
    for stance in STANCES {
        assert_eq!(
            plan_of(&st, stance, rt::unit_of(&st, WILD).pos),
            vec![END],
            "{stance:?}"
        );
    }
}

/// BT4.6: a CROSS-SIDE duplicate id — a side-A unit (slot 1, at (0,6)) carrying the wild's own
/// id 11, appended to the melee duel — is a hostile state: `Unit(11)` names two units →
/// `[End]` for every stance (the duel itself plans `[Heavy → P1, End]`).
/// Kills: the duplicate-id guard keyed by `(id, side)` (→ `[Heavy → P1, End]`).
#[test]
fn a_player_sharing_the_wilds_id_leaves_the_wild_nothing_but_end_turn_bt4_6() {
    let st = edited(duel(melee_kit()), |st| {
        st.units.push(player(WILD, 1, 0, 6, 100));
    });
    for stance in STANCES {
        assert_eq!(plan_of(&st, stance, rt::c(3, 3)), vec![END], "{stance:?}");
    }
}

/// BT4.6 / J12 (pack-mate collateral is not scored): wild 11 at (3,3) with one Heavy, the
/// `diamond_all`; P1 at (5,3); the pack-mate wild 12 (slot 1, melee kit) at (5,4), INSIDE the
/// diamond around P1, while wild 11 (2 from P1) is outside it. The set {P1, 12} holds only valid
/// units and not wild 11 → the attack from the own tile (untaxed, 4 AP): `[Heavy 20 → P1, End]`.
/// Through the executor (levelled speeds 80 and 70 against P1's 30, so both wilds act first):
/// wild 11 plans that, wild 12 (P1 adjacent, melee Heavy from its own tile) plans
/// `[Heavy 20 → P1, End]`, and nothing halts.
/// Kills: an aim refused (or scored away) because it catches a pack-mate (→ the approach
/// `[Move (4,3) ×1, End]`).
#[test]
fn a_pack_mate_inside_the_blast_does_not_stop_the_attack_bt4_6() {
    let st = board(
        vec![
            wild(3, 3, 100, 100, 30, vec![hv(HEAVY, diamond_all())]),
            pack_mate(5, 4, melee_kit()),
            player(P1, 0, 5, 3, 100),
        ],
        &[],
    );
    let want = vec![hit(HEAVY, P1), END];
    assert_eq!(plan_of(&st, Stance::Aggressive, rt::c(3, 3)), want);
    let t = rt::design();
    let (out, _battle, hooks) = start_battle(
        st,
        vec![
            (WILD, Stance::Aggressive, rt::c(3, 3)),
            (MATE, Stance::Aggressive, rt::c(5, 4)),
        ],
        &t,
    );
    assert_eq!(
        hooks.plans(),
        vec![(WILD, want), (MATE, vec![hit(HEAVY, P1), END])]
    );
    assert!(!halted(&out), "events: {:?}", out.events);
    assert!(out.events.iter().any(
        |e| matches!(e, EventPayload::Executed(x) if x.attacker == WILD && x.skill_id == HEAVY)
    ));
}

/// BT4.6 / J15: a kit entry whose `skill_id` repeats an EARLIER entry's is never planned (the gate
/// and the resolver find a skill by id, first match). Kit [Light 10 melee, Heavy 10 single r2–3],
/// wild (3,3), P1 (3,1) 2 away (untaxed): only the melee Light 10 counts, and nothing hits from
/// the own tile. Beside P1 in reach: (3,2) cost 1, (2,1) and (4,1) cost 3 ((3,0) costs 5) → tier
/// Light, tile (3,2) → `[Move (3,2) ×1, Skill 10 → P1, End]`, which the executor runs with no
/// `PlanHalted`. Kit order swapped [Heavy 10 r2–3, Light 10 melee]: the Heavy is the one that
/// counts and hits from the own tile → `[Skill 10 → P1, End]`.
/// Kills: the shadowing check dropped (→ "Heavy 10" from the own tile, which the gate resolves as
/// the melee Light 10 → `Geometry(OutOfRange)`, halted).
#[test]
fn a_kit_entry_repeating_an_earlier_skill_id_is_never_planned_bt4_6() {
    let kit_of = |skills: Vec<SkillTactics>| {
        board(
            vec![wild(3, 3, 100, 100, 30, skills), player(P1, 0, 3, 1, 100)],
            &[],
        )
    };
    // Both kit entries carry skill id 10.
    let shared = LIGHT;
    let shadowed = kit_of(vec![lt(shared, single(1, 1)), hv(shared, single(2, 3))]);
    let want = vec![mv(3, 2, 1), hit(shared, P1), END];
    assert_eq!(plan_of(&shadowed, Stance::Aggressive, rt::c(3, 3)), want);
    let t = rt::design();
    let (out, _battle, hooks) =
        start_battle(shadowed, vec![(WILD, Stance::Aggressive, rt::c(3, 3))], &t);
    assert_eq!(hooks.plans(), vec![(WILD, want)]);
    assert!(!halted(&out), "events: {:?}", out.events);
    let swapped = kit_of(vec![hv(shared, single(2, 3)), lt(shared, single(1, 1))]);
    assert_eq!(
        plan_of(&swapped, Stance::Aggressive, rt::c(3, 3)),
        vec![hit(shared, P1), END]
    );
}

// ---------------------------------------------------------------------------
// Generated battles (proptest): 6–8 per side, Rough/Water/Blocked, `validate_battle_map` Ok,
// 1–3 wilds (all faster than every player) × 1–3 players × 3 stances, wild HP on both sides of
// the Exhausted boundary, kits drawn from the geometry menu, four tunings.
// ---------------------------------------------------------------------------

/// The geometry menu (design §4.1): melee r1, lance r1–2, single r2–3, Caster Burst(1),
/// TargetUnit Diamond(1) friendly-fire `All`.
fn menu(i: u8) -> SkillGeometry {
    match i % 5 {
        0 => single(1, 1),
        1 => single(1, 2),
        2 => single(2, 3),
        3 => caster_burst(),
        _ => diamond_all(),
    }
}

fn stance_of(i: u8) -> Stance {
    STANCES[usize::from(i) % STANCES.len()]
}

/// DESIGN, `end_turn_cost 1`, `ap_turn 8`, `max_strides_per_turn 3`.
fn tuning_of(i: u8) -> TacticsTuning {
    match i % 4 {
        0 => rt::design(),
        1 => rt::perturb(|t| t.end_turn_cost = 1),
        2 => rt::perturb(|t| t.ap_turn = 8),
        _ => rt::perturb(|t| t.max_strides_per_turn = 3),
    }
}

fn terrain_from(n: u8) -> Terrain {
    match n % 10 {
        0..=5 => Terrain::Plain,
        6 | 7 => Terrain::Rough,
        8 => Terrain::Water,
        _ => Terrain::Blocked,
    }
}

/// Wild HP out of 100: 24 and 1 are Exhausted (×4 < 100), 25 is the boundary, 26 and 100 are not.
const HP_MENU: [u16; 5] = [100, 26, 25, 24, 1];
/// Strides 2, 3, 4.
const BASE_MENU: [u16; 3] = [30, 60, 95];
const PLAYER_HP_MENU: [u16; 3] = [100, 40, 1];

/// (stance, Light geometry, Heavy geometry, Heavy listed first, HP index, base-speed index, tile).
type WildRaw = (u8, u8, u8, bool, u8, u8, u16);
/// (HP index, tile).
type PlayerRaw = (u8, u16);

fn wild_raw() -> impl Strategy<Value = WildRaw> {
    (
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<bool>(),
        any::<u8>(),
        any::<u8>(),
        any::<u16>(),
    )
}

fn player_raw() -> impl Strategy<Value = PlayerRaw> {
    (any::<u8>(), any::<u16>())
}

/// A generated battle: the state, each wild's `(unit, stance, spawn = spawn_b[slot])`, the tuning.
struct Arena {
    state: TacticalState,
    wilds: Vec<(u32, Stance, Cell)>,
    tuning: TacticsTuning,
}

fn cell_of(i: usize, width: usize) -> Cell {
    Cell {
        x: u8::try_from(i % width).expect("x fits u8"),
        y: u8::try_from(i / width).expect("y fits u8"),
    }
}

/// A valid `w × h` map: columns 0 and `w − 1` and row 0 are Plain (so the six spawns
/// `(0, 0/2/4)` and `(w − 1, 0/2/4)` are walkable and connected, 5..=11 apart), every other tile
/// from `terrain_raw`, and every unit's tile forced Plain. Wilds are side B, slot i, id 11 + i,
/// levelled speed 200 − i; players are side A, slot j, id 1 + j, speed 20.
fn arena(
    w: u8,
    h: u8,
    terrain_raw: &[u8],
    wilds_raw: &[WildRaw],
    players_raw: &[PlayerRaw],
    tuning: u8,
    seed: u64,
) -> Arena {
    let wu = usize::from(w);
    let n = wu * usize::from(h);
    let mut tiles: Vec<TileDef> = (0..n)
        .map(|i| {
            let (x, y) = (i % wu, i / wu);
            let edge = x == 0 || x + 1 == wu || y == 0;
            let terrain = if edge {
                Terrain::Plain
            } else {
                terrain_from(terrain_raw.get(i).copied().unwrap_or(0))
            };
            TileDef {
                terrain,
                elevation: 0,
                blocks_los: false,
            }
        })
        .collect();
    let mut taken: Vec<usize> = Vec::new();
    let mut place = |raw: u16| -> Cell {
        let start = usize::from(raw) % n;
        let i = (0..n)
            .map(|k| (start + k) % n)
            .find(|i| !taken.contains(i))
            .expect("six units always fit");
        taken.push(i);
        tiles[i].terrain = Terrain::Plain;
        cell_of(i, wu)
    };
    let last = w - 1;
    let spawn_b = vec![rt::c(last, 0), rt::c(last, 2), rt::c(last, 4)];
    let mut units = Vec::new();
    let mut wilds = Vec::new();
    for (i, raw) in wilds_raw.iter().enumerate() {
        let &(stance, light_geom, heavy_geom, heavy_first, hp, base, cell) = raw;
        let slot = u8::try_from(i).expect("at most three wilds");
        let id = WILD + u32::from(slot);
        let light = lt(LIGHT, menu(light_geom));
        let heavy = hv(HEAVY, menu(heavy_geom));
        let skills = if heavy_first {
            vec![heavy, light]
        } else {
            vec![light, heavy]
        };
        let kit = rt::kit(
            2,
            Affinity::Water,
            5,
            rt::stat_block(100, 10, rt::CHIP_DEF, 200 - u16::from(slot)),
            BASE_MENU[usize::from(base) % BASE_MENU.len()],
            MoveClass::Walk,
            skills,
        );
        let pos = place(cell);
        units.push(rt::unit(
            id,
            Side::B,
            slot,
            pos,
            kit,
            HP_MENU[usize::from(hp) % HP_MENU.len()],
        ));
        wilds.push((id, stance_of(stance), spawn_b[usize::from(slot)]));
    }
    for (j, &(hp, cell)) in players_raw.iter().enumerate() {
        let slot = u8::try_from(j).expect("at most three players");
        let pos = place(cell);
        units.push(rt::unit(
            P1 + u32::from(slot),
            Side::A,
            slot,
            pos,
            rt::water(100, rt::CHIP_DEF, 20, Vec::new()),
            PLAYER_HP_MENU[usize::from(hp) % PLAYER_HP_MENU.len()],
        ));
    }
    let map = BattleMapDef {
        width: w,
        height: h,
        tiles,
        spawn_a: vec![rt::c(0, 0), rt::c(0, 2), rt::c(0, 4)],
        spawn_b,
    };
    assert_eq!(
        validate_battle_map(&map),
        Ok(()),
        "the generator builds valid maps"
    );
    let state =
        TacticalState::new(BattleKind::Wild, seed, &map, units).expect("generated units deploy");
    Arena {
        state,
        wilds,
        tuning: tuning_of(tuning),
    }
}

/// The four plan shapes the contract allows: `[End]`, `[Move, End]`, `[Skill, End]`,
/// `[Move, Skill, End]`.
fn plan_shape_ok(plan: &[QueuedAction]) -> bool {
    matches!(
        plan,
        [QueuedAction::EndTurn]
            | [QueuedAction::Move(_), QueuedAction::EndTurn]
            | [QueuedAction::Skill(_), QueuedAction::EndTurn]
            | [
                QueuedAction::Move(_),
                QueuedAction::Skill(_),
                QueuedAction::EndTurn
            ]
    )
}

// --- the execution gate as the independent oracle --------------------------------------------

/// Every start the GATE admits for `unit` on `shown` (the state the planner was handed — its
/// budget already fresh from TurnStart): its own tile, then each tile a `Move{c, s}` reaches for
/// the least `s` `validate_at_pop` accepts, with the state after that Move (actor relocated, the
/// entry spent on its budget, as the executor charges it).
fn gate_starts(shown: &TacticalState, unit: u32, t: &TacticsTuning) -> Vec<(Cell, TacticalState)> {
    let pos = shown.unit(unit).expect("the actor is on the board").pos;
    let mut starts = vec![(pos, shown.clone())];
    for y in 0..shown.height {
        for x in 0..shown.width {
            let c = Cell { x, y };
            if c == pos {
                continue;
            }
            for strides in 1..=t.max_strides_per_turn {
                let action = QueuedAction::Move(MoveAction { x, y, strides });
                if let Ok(Validated::Move { entry, .. }) =
                    validate_at_pop(shown, unit, &action, &NoHooks, t)
                {
                    let mut st = shown.clone();
                    let u = st.unit_mut(unit).expect("the actor");
                    if spend(&mut u.budget, entry, t).is_ok() {
                        u.pos = c;
                        starts.push((c, st));
                    }
                    break;
                }
            }
        }
    }
    starts
}

/// Whether the trailing `EndTurn` is still affordable for `unit` on `st`.
fn end_turn_affordable(st: &TacticalState, unit: u32, t: &TacticsTuning) -> bool {
    st.unit(unit).is_some_and(|u| {
        let mut budget = u.budget;
        spend(&mut budget, Entry::EndTurn, t).is_ok()
    })
}

/// Whether the gate admits SOME `[Move?, Skill, EndTurn]` from an `allowed` start whose skill
/// (Heavy only when `heavy_only`) hits a conscious enemy and not the actor (J11).
fn gate_admits_an_attack(
    starts: &[(Cell, TacticalState)],
    unit: u32,
    allowed: impl Fn(Cell) -> bool,
    heavy_only: bool,
    t: &TacticsTuning,
) -> bool {
    for (c, st) in starts {
        if !allowed(*c) {
            continue;
        }
        let Some(actor) = st.unit(unit) else {
            continue;
        };
        let enemies: Vec<u32> = st
            .units
            .iter()
            .filter(|u| u.side != actor.side && u.is_conscious())
            .map(|u| u.id)
            .collect();
        for skill in &actor.kit.skills {
            if heavy_only && skill.tier != Tier::Heavy {
                continue;
            }
            let aims = std::iter::once(ActionTarget::SelfTarget)
                .chain(enemies.iter().map(|&id| ActionTarget::Unit(id)));
            for target in aims {
                let action = QueuedAction::Skill(SkillAction {
                    skill_id: skill.skill_id,
                    target,
                });
                let Ok(Validated::Skill { targets, .. }) =
                    validate_at_pop(st, unit, &action, &NoHooks, t)
                else {
                    continue;
                };
                let hits_enemy = match target {
                    ActionTarget::Unit(id) => targets.contains(&id),
                    ActionTarget::SelfTarget => targets.iter().any(|id| enemies.contains(id)),
                };
                if !hits_enemy || targets.contains(&unit) {
                    continue;
                }
                let mut budget = actor.budget;
                if spend(&mut budget, Entry::Attack(skill.tier), t).is_ok()
                    && spend(&mut budget, Entry::EndTurn, t).is_ok()
                {
                    return true;
                }
            }
        }
    }
    false
}

/// The tiles a stance may attack from: an Exhausted wild only its own (the universal override);
/// a Territorial wild its own or one within 2 of its spawn; otherwise any.
fn tile_allowed(c: Cell, pos: Cell, spawn: Cell, exhausted: bool, stance: Stance) -> bool {
    if exhausted {
        c == pos
    } else if stance == Stance::Territorial {
        c == pos || manhattan(c, spawn) <= 2
    } else {
        true
    }
}

/// The stance sentences (BT4.2–BT4.5) checked on one planned turn against the gate oracle:
/// the wild attacks iff the gate admits a stance-allowed attack; an Exhausted wild never moves;
/// a Territorial wild ends within 2 of its spawn or unmoved and, not attacking, ends its turn;
/// a Skittish (non-Exhausted) wild only uses a Heavy; a non-attacking Aggressive wild ends on the
/// least `d` any admissible move reaches (so an approach strictly reduces `d`, or it stays); a
/// non-attacking Skittish wild ends on the farthest in-band tile, else (nothing in band) on the
/// least `d`.
fn check_stance_sentences(
    turn: &Turn,
    stance: Stance,
    spawn: Cell,
    t: &TacticsTuning,
) -> Result<(), TestCaseError> {
    let shown = &turn.shown;
    let actor = shown
        .unit(turn.unit)
        .expect("the planner's actor is on the board it was shown");
    let pos = actor.pos;
    let exhausted = u32::from(actor.cur_hp) * 4 < u32::from(actor.max_hp());
    let players: Vec<Cell> = shown
        .units
        .iter()
        .filter(|u| u.side != actor.side && u.is_conscious())
        .map(|u| u.pos)
        .collect();
    let d = |c: Cell| {
        players
            .iter()
            .map(|&p| manhattan(c, p))
            .min()
            .unwrap_or(u16::MAX)
    };
    let dest = turn.plan.iter().find_map(|e| match e {
        QueuedAction::Move(m) => Some(m.dest()),
        _ => None,
    });
    let skill = turn.plan.iter().find_map(|e| match e {
        QueuedAction::Skill(s) => Some(s.skill_id),
        _ => None,
    });
    let end = dest.unwrap_or(pos);
    let starts = gate_starts(shown, turn.unit, t);
    let heavy_only = !exhausted && stance == Stance::Skittish;
    let can_attack = gate_admits_an_attack(
        &starts,
        turn.unit,
        |c| tile_allowed(c, pos, spawn, exhausted, stance),
        heavy_only,
        t,
    );
    let ctx = format!(
        "unit {} {:?} exhausted {} at {:?} planned {:?}",
        turn.unit, stance, exhausted, pos, turn.plan
    );
    prop_assert_eq!(
        skill.is_some(),
        can_attack,
        "attack iff the gate admits one: {}",
        ctx
    );
    if exhausted {
        prop_assert!(dest.is_none(), "an Exhausted wild moved: {}", ctx);
    }
    if stance == Stance::Territorial {
        if let Some(c) = dest {
            prop_assert!(
                manhattan(c, spawn) <= 2,
                "left its leash (spawn {:?}): {}",
                spawn,
                ctx
            );
        }
    }
    if let (true, Some(id)) = (heavy_only, skill) {
        prop_assert!(
            actor
                .kit
                .skills
                .iter()
                .any(|s| s.skill_id == id && s.tier == Tier::Heavy),
            "a Skittish wild used a non-Heavy skill: {}",
            ctx
        );
    }
    if skill.is_none() {
        let open: Vec<u16> = starts
            .iter()
            .filter(|(_, st)| end_turn_affordable(st, turn.unit, t))
            .map(|(c, _)| d(*c))
            .collect();
        let nearest = open.iter().copied().min().unwrap_or(u16::MAX);
        match (exhausted, stance) {
            (true, _) | (false, Stance::Territorial) => {
                prop_assert!(
                    matches!(turn.plan.as_slice(), [QueuedAction::EndTurn]),
                    "no attack, so the plan is [End]: {}",
                    ctx
                );
            }
            (false, Stance::Aggressive) => {
                prop_assert_eq!(d(end), nearest, "the approach is not the least d: {}", ctx);
                prop_assert!(
                    end == pos || d(end) < d(pos),
                    "a non-improving move: {}",
                    ctx
                );
            }
            (false, Stance::Skittish) => {
                let band = actor
                    .kit
                    .skills
                    .iter()
                    .filter(|s| s.tier == Tier::Heavy)
                    .map(|s| u16::from(s.geometry.range_max))
                    .max()
                    .unwrap_or(0)
                    + 2;
                match open.iter().copied().filter(|&dc| dc <= band).max() {
                    Some(farthest) => prop_assert_eq!(
                        d(end),
                        farthest,
                        "not the farthest in-band tile (band {}): {}",
                        band,
                        ctx
                    ),
                    None => prop_assert_eq!(
                        d(end),
                        nearest,
                        "out of band, not the approach (band {}): {}",
                        band,
                        ctx
                    ),
                }
            }
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// BT4.1: on generated battles, every wild's plan is the same whatever the secret stream
    /// (`seed`, `action_seq`) and whatever budget its row stores (J14).
    /// Kills: any read of the seed, the action counter or `actor.budget`.
    #[test]
    fn the_plan_is_blind_to_the_secret_stream_and_the_stored_budget_on_generated_boards_bt4_1(
        w in 6u8..=8,
        h in 6u8..=8,
        terrain_raw in prop::collection::vec(any::<u8>(), 64),
        wilds_raw in prop::collection::vec(wild_raw(), 1..=3),
        players_raw in prop::collection::vec(player_raw(), 1..=3),
        tuning in any::<u8>(),
        seed in any::<u64>(),
        action_seq in any::<u64>(),
        budget in (any::<u8>(), any::<u8>(), any::<u8>()),
    ) {
        let a = arena(w, h, &terrain_raw, &wilds_raw, &players_raw, tuning, 0);
        for &(id, stance, spawn) in &a.wilds {
            let base = plan(&a.state, id, stance, spawn, &a.tuning);
            let mut secret = a.state.clone();
            secret.seed = seed;
            secret.action_seq = action_seq;
            if let Some(u) = secret.unit_mut(id) {
                u.budget = TurnBudget {
                    ap: budget.0,
                    strides_used: budget.1,
                    attacks: budget.2,
                    last: Some(Entry::Attack(Tier::Light)),
                };
            }
            prop_assert_eq!(
                &plan(&secret, id, stance, spawn, &a.tuning),
                &base,
                "wild {} {:?}",
                id,
                stance
            );
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    /// BT4.6 through the REAL executor on generated battles: no `PlanHalted` is ever emitted, and
    /// every plan `plan_ai` returned holds only Move / Skill entries before a trailing `EndTurn`
    /// (never Item, Recruit or Flee), in one of the four contract shapes.
    /// Kills: a plan the gate refuses (any re-implemented rule drifting from the gate's); an
    /// Item / Recruit / Flee; a missing trailing EndTurn.
    #[test]
    fn every_stance_plans_only_moves_and_skills_and_never_halts_in_the_executor_bt4_6(
        w in 6u8..=8,
        h in 6u8..=8,
        terrain_raw in prop::collection::vec(any::<u8>(), 64),
        wilds_raw in prop::collection::vec(wild_raw(), 1..=3),
        players_raw in prop::collection::vec(player_raw(), 1..=3),
        tuning in any::<u8>(),
        seed in any::<u64>(),
    ) {
        let a = arena(w, h, &terrain_raw, &wilds_raw, &players_raw, tuning, seed);
        let (out, _battle, hooks) = start_battle(a.state.clone(), a.wilds.clone(), &a.tuning);
        let turns = hooks.turns.borrow();
        prop_assert!(!turns.is_empty(), "the fastest wild always plans");
        prop_assert!(!halted(&out), "a wild plan halted: {:?}", out.events);
        for turn in turns.iter() {
            prop_assert!(
                turn.plan
                    .iter()
                    .all(|e| matches!(e, QueuedAction::Move(_) | QueuedAction::Skill(_) | QueuedAction::EndTurn)),
                "unit {} planned {:?}",
                turn.unit,
                turn.plan
            );
            prop_assert_eq!(turn.plan.last(), Some(&QueuedAction::EndTurn));
            prop_assert!(plan_shape_ok(&turn.plan), "unit {} planned {:?}", turn.unit, turn.plan);
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// BT4.6 (the stance sentences through the executor), on generated battles, each planned turn
    /// judged against the execution gate on the board the planner was shown: the wild attacks iff
    /// a stance-allowed `[Move?, Skill, End]` passes the gate; Exhausted never moves; Territorial
    /// ends within 2 of its spawn or unmoved and otherwise ends its turn; Skittish only uses a
    /// Heavy; a non-attacking Aggressive wild reaches the least `d` (an approach strictly reduces
    /// `d` or the plan is `[End]`); a non-attacking Skittish wild ends farthest within its band.
    /// Kills: a missed attack; an attack the stance forbids; an Exhausted Move; a leash breach; an
    /// approach that is not the closest admissible tile; a kite outside its band.
    #[test]
    fn through_the_executor_every_stance_keeps_its_sentence_bt4_6(
        w in 6u8..=8,
        h in 6u8..=8,
        terrain_raw in prop::collection::vec(any::<u8>(), 64),
        wilds_raw in prop::collection::vec(wild_raw(), 1..=3),
        players_raw in prop::collection::vec(player_raw(), 1..=3),
        tuning in any::<u8>(),
        seed in any::<u64>(),
    ) {
        let a = arena(w, h, &terrain_raw, &wilds_raw, &players_raw, tuning, seed);
        let (out, _battle, hooks) = start_battle(a.state.clone(), a.wilds.clone(), &a.tuning);
        prop_assert!(!halted(&out), "a wild plan halted: {:?}", out.events);
        let turns = hooks.turns.borrow();
        prop_assert!(!turns.is_empty(), "the fastest wild always plans");
        for turn in turns.iter() {
            let &(_, stance, spawn) = a
                .wilds
                .iter()
                .find(|entry| entry.0 == turn.unit)
                .expect("only wilds are planned");
            check_stance_sentences(turn, stance, spawn, &a.tuning)?;
        }
    }
}
