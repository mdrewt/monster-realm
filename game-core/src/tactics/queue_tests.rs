//! bt-3 gating tests for `tactics::queue` — the turn machine: the submit gate (BT3.2), the
//! execution gate (BT3.3), halt-and-return (BT3.4), TurnStart (BT3.5), the chain rule (BT3.6),
//! READY rows (BT3.7), `InvalidNow` (BT3.8), the machine half of the idle clock (BT3.9) and the
//! machine half of event emission (BT3.10).
//!
//! Every expected value is hand-derived from the slice contract (plan memo, "queue.rs — the
//! machine (AMENDED)") at `TacticsTuning::DESIGN`, never read back from the implementation.
//!
//! # Fixtures
//!
//! An 8×8 all-Plain board (Rough / Blocked tiles patched in where a test needs them). Every unit
//! is a level-5 Water unit with attack 10 and defence 100 (`CHIP_DEF`), 100 max HP, a speed
//! ≤ 49 unless a test says otherwise (stride 2: one stride buys 2 Plain tiles) and the same
//! kit: LIGHT (melee Light), HEAVY
//! (melee Heavy), SPLASH (range-3 radius-1 diamond, enemies), NOVA (radius-1 ring around the
//! caster, enemies — a valid attack even with no target), SELF_NOVA (radius-1 diamond around the
//! caster, ALL — it hits the caster) and TAIL (melee Light; used only in plans that halt before
//! it). Every attack is Fire into Water at accuracy 100, so every hit removes exactly 1 HP
//! (resolve_tests' "chip" derivation); a 1-HP target with First-Stand cleared is KO'd by it.
//!
//! Side A ids are 1..=9, side B ids are 11..=19. `FakeHooks` keys the inventory by OWNER:
//! `owner_of(unit)` is 0 for every side-A unit and 1 for every side-B unit, so two player units
//! share one bag. Initiative is speed-descending (no ties are ever built).
//!
//! Test names end in the criterion tag `_bt3_<k>`.

use std::cell::RefCell;

use serde::de::value::{Error as ValueError, U32Deserializer};
use serde::de::{DeserializeOwned, IntoDeserializer};
use serde_json::Value;

use crate::combat::status::{apply_pre_turn_effects, BattleStatusStore, StatusVariance};
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{BattleOutcome, BattleSide, BattleState, StatusEffect};
use crate::monster::types::Affinity;

use super::clock::{ClockState, Window};
use super::economy::{EconomyError, Entry, Tier, TurnBudget};
use super::events::{
    AutoPassEvent, AwardsEvent, BattleEndEvent, BattleStartedEvent, EndHow, EventPayload,
    ExecutedEvent, HaltKind, HitEffectiveness, ItemUsedEvent, KoEvent, MissedEvent, MovedEvent,
    PlanHaltedEvent, QueueVoidedEvent, RecruitResultEvent, RoundEndedEvent, StatusChange,
    StatusEvent, StoodGroundEvent, SurgeEvent, TargetHit, TurnEndedEvent,
};
use super::geometry::{target_set, FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry};
use super::map::{BattleMapDef, TileDef};
use super::movement::{Path, PathError, Terrain};
use super::queue::{
    is_player_owned, min_action_cost, status_blocks_turn, validate_at_pop, AdvancePin, CancelError,
    ConcludeError, ExpireError, HaltReason, Hooks, ReadyPlan, Rules, StepError, StepResult,
    SubmitError, TacticalBattle, Validated,
};
use super::resolve::{
    turn_start, ActError, DeployError, SkillTactics, TacticalState, TacticalUnit, UnitState,
};
use super::resolve_tests::{
    c, chart, design, diamond, heavy, light, melee, mix, perturb, unit, water, CHIP_DEF,
};
use super::tuning::{BattleKind, TacticsTuning, TuningError};
use super::types::{
    ActionKind, ActionTarget, ItemAction, MoveAction, Phase, QueuedAction, RecruitAction,
    SkillAction, TurnState,
};

// ===========================================================================
// Fixtures
// ===========================================================================

const BID: u64 = 0x00B7_0003;
const T0: i64 = 1_000_000;
/// DESIGN window budgets.
const PVE_MS: i64 = 300_000;
const PVP_MS: i64 = 30_000;

const LIGHT: u32 = 10;
const HEAVY: u32 = 20;
const SPLASH: u32 = 40;
const NOVA: u32 = 50;
const SELF_NOVA: u32 = 60;
const TAIL: u32 = 4242;

const POTION: u32 = 501;
const BAIT: u32 = 502;
const ETHER: u32 = 503;

const NVE: Option<HitEffectiveness> = Some(HitEffectiveness::NotVeryEffective);
const END: QueuedAction = QueuedAction::EndTurn;
const FLEE: QueuedAction = QueuedAction::Flee;

/// The radius-1 ring around the caster (aim = the caster), enemies only.
fn caster_ring() -> SkillGeometry {
    SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Burst,
        radius: 1,
        ff_filter: FfFilter::Enemies,
    }
}

/// The radius-1 diamond around the caster INCLUDING the caster, everyone.
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

fn kit_skills() -> Vec<SkillTactics> {
    vec![
        light(LIGHT, Affinity::Fire, melee()),
        heavy(HEAVY, Affinity::Fire, 20, melee()),
        light(SPLASH, Affinity::Fire, diamond(FfFilter::Enemies, 3)),
        light(NOVA, Affinity::Fire, caster_ring()),
        light(SELF_NOVA, Affinity::Fire, caster_diamond_all()),
        light(TAIL, Affinity::Fire, melee()),
    ]
}

/// A 100/100-HP chip-defence unit at `(x, y)`; `speed` is its levelled AND base speed.
fn mon(id: u32, side: Side, slot: u8, x: u8, y: u8, speed: u16) -> TacticalUnit {
    unit(
        id,
        side,
        slot,
        c(x, y),
        water(100, CHIP_DEF, speed, kit_skills()),
        100,
    )
}

fn with_hp(mut u: TacticalUnit, hp: u16) -> TacticalUnit {
    u.cur_hp = hp;
    u
}

/// First-Stand already spent (a unit that has had a turn), so a lethal hit is not saved.
fn exposed(mut u: TacticalUnit) -> TacticalUnit {
    u.first_stand = false;
    u
}

fn afflicted(mut u: TacticalUnit, status: StatusEffect) -> TacticalUnit {
    u.status = Some(status);
    u
}

/// An 8×8 all-Plain map with `overrides` patched in.
fn map8(overrides: &[(u8, u8, Terrain)]) -> BattleMapDef {
    let mut tiles = vec![
        TileDef {
            terrain: Terrain::Plain,
            elevation: 0,
            blocks_los: false,
        };
        64
    ];
    for &(x, y, terrain) in overrides {
        tiles[usize::from(y) * 8 + usize::from(x)].terrain = terrain;
    }
    BattleMapDef {
        width: 8,
        height: 8,
        tiles,
        spawn_a: vec![c(0, 0), c(0, 3), c(0, 6)],
        spawn_b: vec![c(7, 1), c(7, 4), c(7, 7)],
    }
}

fn state_on(
    kind: BattleKind,
    seed: u64,
    overrides: &[(u8, u8, Terrain)],
    units: Vec<TacticalUnit>,
) -> TacticalState {
    TacticalState::new(kind, seed, &map8(overrides), units).expect("fixture battles are valid")
}

fn battle_of(kind: BattleKind, seed: u64, units: Vec<TacticalUnit>) -> TacticalBattle {
    TacticalBattle::new(BID, state_on(kind, seed, &[], units))
}

fn wild(units: Vec<TacticalUnit>) -> TacticalBattle {
    battle_of(BattleKind::Wild, 7, units)
}

fn pvp_battle(units: Vec<TacticalUnit>) -> TacticalBattle {
    battle_of(BattleKind::Pvp, 9, units)
}

/// The rule inputs (`Rules` borrows them).
struct World {
    ch: TypeChart,
    t: TacticsTuning,
}

impl World {
    fn new() -> World {
        World {
            ch: chart(),
            t: design(),
        }
    }

    fn tuned(t: TacticsTuning) -> World {
        World { ch: chart(), t }
    }

    fn rules(&self) -> Rules<'_> {
        Rules {
            chart: &self.ch,
            tuning: &self.t,
        }
    }
}

// ===========================================================================
// FakeHooks
// ===========================================================================

/// What the fake Item resolver does to the resolved target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemFx {
    /// Heal the target by N (capped at max HP).
    Heal(u16),
    /// Every unit on the board drops to 0 HP (a "damaging item" that KOs both sides).
    Wipe,
}

/// The injected seam. The inventory is keyed by OWNER (`owner_of`), the AI plans are scripted
/// per unit (default `[EndTurn]`), `validate_delegated` returns `refuse` when set, and every
/// call is logged so a test can pin how many times (and with what) the executor asked.
struct FakeHooks {
    /// `(owner, item_id, count)`.
    inventory: Vec<(u32, u32, u32)>,
    headroom: bool,
    ai: Vec<(u32, Vec<QueuedAction>)>,
    refuse: Option<HaltReason>,
    /// `take_item` answers `false` whatever is held (a debit that loses a race).
    take_fails: bool,
    item_fx: ItemFx,
    /// Appended to every `resolve_delegated` answer (legal kinds and forged ones).
    extra: Vec<EventPayload>,
    item_count_calls: RefCell<Vec<(u32, u32)>>,
    plan_ai_calls: RefCell<Vec<u32>>,
    validate_calls: RefCell<Vec<(u32, Validated)>>,
    take_calls: Vec<(u32, u32)>,
    resolve_calls: Vec<(u32, Validated)>,
}

/// Both player sides' units map to one owner per side: A → 0, B → 1.
fn owner_of(unit: u32) -> u32 {
    if unit < 10 {
        0
    } else {
        1
    }
}

impl FakeHooks {
    fn new() -> FakeHooks {
        FakeHooks {
            inventory: Vec::new(),
            headroom: true,
            ai: Vec::new(),
            refuse: None,
            take_fails: false,
            item_fx: ItemFx::Heal(20),
            extra: Vec::new(),
            item_count_calls: RefCell::new(Vec::new()),
            plan_ai_calls: RefCell::new(Vec::new()),
            validate_calls: RefCell::new(Vec::new()),
            take_calls: Vec::new(),
            resolve_calls: Vec::new(),
        }
    }

    /// Owner 0 (side A) holds `count` of `item_id`.
    fn holding(mut self, item_id: u32, count: u32) -> FakeHooks {
        self.inventory.push((0, item_id, count));
        self
    }

    fn ai_plan(mut self, unit: u32, plan: Vec<QueuedAction>) -> FakeHooks {
        self.ai.push((unit, plan));
        self
    }

    fn held(&self, owner: u32, item_id: u32) -> u32 {
        self.inventory
            .iter()
            .filter(|s| s.0 == owner && s.1 == item_id)
            .map(|s| s.2)
            .sum()
    }

    fn set_held(&mut self, owner: u32, item_id: u32, count: u32) {
        self.inventory.retain(|s| !(s.0 == owner && s.1 == item_id));
        self.inventory.push((owner, item_id, count));
    }

    fn plan_ai_log(&self) -> Vec<u32> {
        self.plan_ai_calls.borrow().clone()
    }

    fn validate_log(&self) -> Vec<(u32, Validated)> {
        self.validate_calls.borrow().clone()
    }

    fn item_count_log(&self) -> Vec<(u32, u32)> {
        self.item_count_calls.borrow().clone()
    }
}

impl Hooks for FakeHooks {
    fn item_count(&self, unit: u32, item_id: u32) -> u32 {
        self.item_count_calls.borrow_mut().push((unit, item_id));
        self.held(owner_of(unit), item_id)
    }

    fn take_item(&mut self, unit: u32, item_id: u32) -> bool {
        self.take_calls.push((unit, item_id));
        if self.take_fails {
            return false;
        }
        let owner = owner_of(unit);
        match self
            .inventory
            .iter_mut()
            .find(|s| s.0 == owner && s.1 == item_id && s.2 > 0)
        {
            Some(slot) => {
                slot.2 -= 1;
                true
            }
            None => false,
        }
    }

    fn recruit_headroom(&self, _unit: u32) -> bool {
        self.headroom
    }

    fn plan_ai(&self, _state: &TacticalState, unit: u32) -> Vec<QueuedAction> {
        self.plan_ai_calls.borrow_mut().push(unit);
        self.ai
            .iter()
            .find(|(u, _)| *u == unit)
            .map_or_else(|| vec![QueuedAction::EndTurn], |(_, plan)| plan.clone())
    }

    fn validate_delegated(
        &self,
        _state: &TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Result<(), HaltReason> {
        self.validate_calls
            .borrow_mut()
            .push((unit, validated.clone()));
        match self.refuse {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Vec<EventPayload> {
        self.resolve_calls.push((unit, validated.clone()));
        let mut out = Vec::new();
        match validated {
            Validated::Item { target, .. } => match self.item_fx {
                ItemFx::Heal(n) => {
                    if let Some(u) = state.unit_mut(*target) {
                        u.cur_hp = u.cur_hp.saturating_add(n).min(u.max_hp());
                    }
                }
                ItemFx::Wipe => {
                    for u in &mut state.units {
                        u.cur_hp = 0;
                    }
                }
            },
            Validated::Recruit { target, .. } => {
                if let Some(u) = state.unit_mut(*target) {
                    u.state = UnitState::Recruited;
                }
                state.remove_from_initiative(*target);
                out.push(EventPayload::RecruitResult(RecruitResultEvent {
                    unit,
                    target: *target,
                    success: true,
                    pct: 50,
                }));
            }
            Validated::Move { .. }
            | Validated::Skill { .. }
            | Validated::Flee { .. }
            | Validated::EndTurn => {}
        }
        out.extend(self.extra.iter().cloned());
        out
    }
}

// ===========================================================================
// Entries and events
// ===========================================================================

fn mv(x: u8, y: u8, strides: u8) -> QueuedAction {
    QueuedAction::Move(MoveAction { x, y, strides })
}

fn sk(skill_id: u32, target: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id,
        target: ActionTarget::Unit(target),
    })
}

fn sk_self(skill_id: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id,
        target: ActionTarget::SelfTarget,
    })
}

fn use_item(item_id: u32, target: ActionTarget) -> QueuedAction {
    QueuedAction::Item(ItemAction { item_id, target })
}

fn recruit(target: u32, bait: Option<u32>) -> QueuedAction {
    QueuedAction::Recruit(RecruitAction { target, bait })
}

/// A chip hit: 1 HP, not very effective, no flank, no Guard, no KO.
fn chip(unit: u32) -> TargetHit {
    TargetHit {
        unit,
        hit: true,
        damage: 1,
        effectiveness: NVE,
        flank: false,
        guard: false,
        ko: false,
    }
}

/// A chip hit that KOs a 1-HP target.
fn lethal(unit: u32) -> TargetHit {
    TargetHit {
        ko: true,
        ..chip(unit)
    }
}

fn executed(attacker: u32, skill_id: u32, results: Vec<TargetHit>) -> EventPayload {
    EventPayload::Executed(ExecutedEvent {
        attacker,
        skill_id,
        results,
    })
}

fn moved(unit: u32, from: (u8, u8), to: (u8, u8), tiles: u8) -> EventPayload {
    EventPayload::Moved(MovedEvent {
        unit,
        from_x: from.0,
        from_y: from.1,
        to_x: to.0,
        to_y: to.1,
        tiles,
    })
}

fn ended(unit: u32, guard: bool, committed: bool) -> EventPayload {
    EventPayload::TurnEnded(TurnEndedEvent {
        unit,
        guard,
        committed,
    })
}

fn halted(unit: u32, idx: u8, reason_kind: HaltKind) -> EventPayload {
    EventPayload::PlanHalted(PlanHaltedEvent {
        unit,
        idx,
        reason_kind,
    })
}

fn voided(unit: u32) -> EventPayload {
    EventPayload::QueueVoided(QueueVoidedEvent { unit })
}

fn ko(unit: u32) -> EventPayload {
    EventPayload::Ko(KoEvent { unit })
}

fn round_ended(round: u16) -> EventPayload {
    EventPayload::RoundEnded(RoundEndedEvent { round })
}

fn battle_started(round: u16) -> EventPayload {
    EventPayload::BattleStarted(BattleStartedEvent { round })
}

fn battle_end(outcome: BattleOutcome, how: EndHow) -> EventPayload {
    EventPayload::BattleEnd(BattleEndEvent { outcome, how })
}

fn status_ev(unit: u32, status: StatusEffect, change: StatusChange, amount: u16) -> EventPayload {
    EventPayload::Status(StatusEvent {
        unit,
        status,
        change,
        amount,
    })
}

fn item_used(unit: u32, item_id: u32, target: u32) -> EventPayload {
    EventPayload::ItemUsed(ItemUsedEvent {
        unit,
        item_id,
        target,
    })
}

fn auto_pass(unit: u32, strike: u8) -> EventPayload {
    EventPayload::AutoPass(AutoPassEvent { unit, strike })
}

fn awards(unit: u32) -> EventPayload {
    EventPayload::Awards(AwardsEvent {
        unit,
        xp: 7,
        essence: 8,
        currency: 9,
    })
}

/// How many events satisfy `pred`.
fn count(events: &[EventPayload], pred: impl Fn(&EventPayload) -> bool) -> usize {
    events.iter().filter(|e| pred(e)).count()
}

/// Every unsigned number anywhere in the serialized events (ids, coordinates, amounts).
fn numbers_in(events: &[EventPayload]) -> Vec<u64> {
    fn walk(v: &Value, out: &mut Vec<u64>) {
        match v {
            Value::Number(n) => {
                if let Some(x) = n.as_u64() {
                    out.push(x);
                }
            }
            Value::Array(items) => {
                for x in items {
                    walk(x, out);
                }
            }
            Value::Object(fields) => {
                for x in fields.values() {
                    walk(x, out);
                }
            }
            Value::Null | Value::Bool(_) | Value::String(_) => {}
        }
    }
    let mut out = Vec::new();
    for e in events {
        walk(
            &serde_json::to_value(e).expect("payloads serialize"),
            &mut out,
        );
    }
    out
}

/// The variant at declaration index `i`, through serde's index deserializer.
fn by_index<T: DeserializeOwned>(i: u32) -> Result<T, ValueError> {
    let d: U32Deserializer<ValueError> = i.into_deserializer();
    T::deserialize(d)
}

// ===========================================================================
// Driving the machine
// ===========================================================================

fn unit_in(b: &TacticalBattle, id: u32) -> &TacticalUnit {
    b.state.unit(id).expect("the unit exists")
}

fn side_of(b: &TacticalBattle, id: u32) -> Side {
    unit_in(b, id).side
}

fn start_at(b: &mut TacticalBattle, now: i64, w: &World, h: &mut FakeHooks) -> StepResult {
    b.start(now, &w.rules(), h).expect("the battle starts")
}

/// An accepted submit by the unit's own side (live when it is the waiting unit, else a pre-queue).
fn submit(
    b: &mut TacticalBattle,
    now: i64,
    unit: u32,
    entries: Vec<QueuedAction>,
    w: &World,
    h: &mut FakeHooks,
) -> StepResult {
    let side = side_of(b, unit);
    b.submit_queue(now, side, unit, entries, &w.rules(), h)
        .expect("the submit is accepted")
}

/// A refused submit: `validate_submit` and `submit_queue` agree, and the battle is byte-identical.
fn refused(
    b: &mut TacticalBattle,
    now: i64,
    sender: Side,
    unit: u32,
    entries: Vec<QueuedAction>,
    w: &World,
    h: &mut FakeHooks,
) -> SubmitError {
    let before = b.clone();
    let checked = b.validate_submit(sender, unit, &entries, &*h, &w.t);
    let got = b.submit_queue(now, sender, unit, entries, &w.rules(), h);
    assert_eq!(
        *b, before,
        "a refused submit leaves the battle byte-identical ({got:?})"
    );
    let err = got.expect_err("the submit is refused");
    assert_eq!(
        checked,
        Err(err),
        "validate_submit agrees with submit_queue"
    );
    err
}

/// `units` in a battle of `kind`, started at T0.
fn drive(
    kind: BattleKind,
    units: Vec<TacticalUnit>,
    w: &World,
    h: &mut FakeHooks,
) -> (TacticalBattle, StepResult) {
    let mut b = battle_of(kind, if kind == BattleKind::Wild { 7 } else { 9 }, units);
    let out = start_at(&mut b, T0, w, h);
    (b, out)
}

/// Wild 1v1 started at T0: player 1 (speed 40) at `p`, wild 11 (speed 30) at `wpos` with the
/// default AI plan `[EndTurn]`. The player is first, so the step stops at `Waiting(1)` with only
/// `BattleStarted` (2 000 ms) as pad: window 1 is [T0 + 2 000, T0 + 302 000].
fn drive_to_waiting(p: (u8, u8), wpos: (u8, u8), w: &World, h: &mut FakeHooks) -> TacticalBattle {
    let (b, out) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, p.0, p.1, 40),
            mon(11, Side::B, 0, wpos.0, wpos.1, 30),
        ],
        w,
        h,
    );
    assert_eq!(
        b.turn_state,
        TurnState::Waiting(1),
        "drive_to_waiting: {out:?}"
    );
    b
}

/// The fresh TurnStart budget at DESIGN.
fn fresh() -> TurnBudget {
    TurnBudget::fresh(&design())
}

// ===========================================================================
// BT3.2 — the submit gate
// ===========================================================================

/// The submit-gate battle: Wild, started at T0, waiting on player 1 (no unit adjacent to an
/// enemy).
///
/// ```text
///   1 A (2,2) speed 40   the waiting unit (live submits)
///   2 A (2,5) speed 35   pre-queues
///  11 B (5,2) speed 30
///   3 A (0,7) speed 25   pre-queues
///  12 B (6,6) speed 20
/// ```
fn gate_battle(w: &World, h: &mut FakeHooks) -> TacticalBattle {
    let (b, out) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            mon(2, Side::A, 1, 2, 5, 35),
            mon(11, Side::B, 0, 5, 2, 30),
            mon(3, Side::A, 2, 0, 7, 25),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
        w,
        h,
    );
    assert_eq!(b.state.initiative, vec![1, 2, 11, 3, 12]);
    assert_eq!(b.turn_state, TurnState::Waiting(1), "{out:?}");
    b
}

/// What every accepted pre-queue returns: nothing happened, in round `round`.
fn quiet(round: u16) -> StepResult {
    StepResult {
        events: vec![],
        round,
        window: None,
        unit_turns: 0,
        actions: 0,
    }
}

fn entries_of(b: &TacticalBattle, unit: u32) -> Option<Vec<QueuedAction>> {
    b.plan(unit).map(|p| p.entries.clone())
}

/// BT3.2: a pre-queue of ≤ 3 actions is stored with `EndTurn` appended iff absent — 3 actions
/// store 4 entries (never 5), `[]` stores `[EndTurn]`, `[EndTurn]` stays `[EndTurn]` — and each
/// accepted pre-queue returns an empty step.
/// Kills: EndTurn appended unconditionally (5 entries); `[]` refused or stored empty.
#[test]
fn a_pre_queue_is_stored_ending_in_exactly_one_end_turn_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    let three = vec![mv(2, 6, 1), mv(2, 7, 1), sk(LIGHT, 11)];
    let mut stored = three.clone();
    stored.push(END);

    assert_eq!(
        submit(&mut b, T0 + 10, 2, three.clone(), &w, &mut h),
        quiet(1)
    );
    assert_eq!(
        b.plan(2),
        Some(&ReadyPlan {
            unit: 2,
            entries: stored.clone(),
        })
    );
    let mut own_end = three;
    own_end.push(END);
    assert_eq!(submit(&mut b, T0 + 20, 2, own_end, &w, &mut h), quiet(1));
    assert_eq!(entries_of(&b, 2), Some(stored), "4 entries, never 5");

    assert_eq!(submit(&mut b, T0 + 30, 2, vec![], &w, &mut h), quiet(1));
    assert_eq!(entries_of(&b, 2), Some(vec![END]));
    assert_eq!(submit(&mut b, T0 + 40, 2, vec![END], &w, &mut h), quiet(1));
    assert_eq!(entries_of(&b, 2), Some(vec![END]));
    assert_eq!(
        submit(&mut b, T0 + 50, 2, vec![mv(2, 6, 1), END], &w, &mut h),
        quiet(1)
    );
    assert_eq!(entries_of(&b, 2), Some(vec![mv(2, 6, 1), END]));
    assert_eq!(b.plans.len(), 1);
    assert_eq!(b.state.queued, vec![2]);
}

/// BT3.2: a pre-queue atomically replaces the unit's previous READY row in place; `plans` stays
/// ascending by unit and `state.queued` holds each id once.
/// Kills: replace-by-push (two rows for one unit); `plans` in submit order.
#[test]
fn a_pre_queue_replaces_the_previous_row_in_place_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    submit(&mut b, T0, 3, vec![END], &w, &mut h);
    submit(&mut b, T0, 2, vec![mv(2, 6, 1)], &w, &mut h);
    submit(&mut b, T0, 3, vec![sk(LIGHT, 12)], &w, &mut h);
    assert_eq!(
        b.plans,
        vec![
            ReadyPlan {
                unit: 2,
                entries: vec![mv(2, 6, 1), END],
            },
            ReadyPlan {
                unit: 3,
                entries: vec![sk(LIGHT, 12), END],
            },
        ]
    );
    assert_eq!(b.state.queued.len(), 2);
    for id in [2u32, 3] {
        assert_eq!(
            b.state.queued.iter().filter(|&&q| q == id).count(),
            1,
            "unit {id} queued once"
        );
    }
}

/// BT3.2: more than 3 action entries is `TooManyActions` with the count saturating at 255 — 4,
/// 5, 255, 256, 259 and 515 entries — for a pre-queue and for a live submit.
/// Kills: `n as u8` (256 → 0, 259 → 3 accepted); a cap of 4.
#[test]
fn too_many_actions_is_refused_with_a_saturating_count_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    for n in [4usize, 5, 255, 256, 259, 515] {
        let count = u8::try_from(n.min(255)).expect("saturated");
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, vec![mv(2, 6, 1); n], &w, &mut h),
            SubmitError::TooManyActions { count },
            "{n} entries"
        );
    }
    assert_eq!(
        refused(&mut b, T0, Side::A, 1, vec![sk(LIGHT, 11); 4], &w, &mut h),
        SubmitError::TooManyActions { count: 4 },
        "live"
    );
}

/// BT3.2: `EndTurn` may only be last.
/// Kills: a non-terminal EndTurn stored (the executor would end the turn mid-plan).
#[test]
fn end_turn_may_only_be_the_last_entry_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    for entries in [
        vec![END, mv(2, 6, 1)],
        vec![mv(2, 6, 1), END, sk(LIGHT, 11)],
        vec![END, END],
    ] {
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, entries.clone(), &w, &mut h),
            SubmitError::EndTurnNotLast,
            "{entries:?}"
        );
    }
}

/// BT3.2: Recruit and Flee must each be the only action (a trailing EndTurn is not an action).
/// Kills: Recruit/Flee combined with a Move; `[Recruit, EndTurn]` refused.
#[test]
fn recruit_and_flee_must_each_be_the_only_action_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![recruit(11, None), mv(2, 6, 1)],
            &w,
            &mut h
        ),
        SubmitError::MustBeAlone(ActionKind::Recruit)
    );
    assert_eq!(
        refused(&mut b, T0, Side::A, 2, vec![mv(2, 6, 1), FLEE], &w, &mut h),
        SubmitError::MustBeAlone(ActionKind::Flee)
    );
    submit(&mut b, T0, 2, vec![recruit(11, None), END], &w, &mut h);
    assert_eq!(entries_of(&b, 2), Some(vec![recruit(11, None), END]));
    submit(&mut b, T0, 2, vec![FLEE], &w, &mut h);
    assert_eq!(entries_of(&b, 2), Some(vec![FLEE, END]));
}

/// BT3.2: Recruit and Flee are refused under the PvP ruleset — Pvp AND Practice — and
/// `MustBeAlone` is reported before `NotInPvp`.
/// Kills: `kind == Pvp` instead of `uses_pvp_rules()` (Practice let through); the order swapped.
#[test]
fn recruit_and_flee_are_refused_under_the_pvp_ruleset_bt3_2() {
    let w = World::new();
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        let mut h = FakeHooks::new();
        let (mut b, _) = drive(
            kind,
            vec![
                mon(1, Side::A, 0, 2, 2, 40),
                mon(2, Side::A, 1, 2, 5, 35),
                mon(11, Side::B, 0, 5, 2, 30),
            ],
            &w,
            &mut h,
        );
        assert_eq!(b.turn_state, TurnState::Waiting(1), "{kind:?}");
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, vec![recruit(11, None)], &w, &mut h),
            SubmitError::NotInPvp(ActionKind::Recruit),
            "{kind:?}"
        );
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, vec![FLEE], &w, &mut h),
            SubmitError::NotInPvp(ActionKind::Flee),
            "{kind:?}"
        );
        assert_eq!(
            refused(
                &mut b,
                T0,
                Side::A,
                2,
                vec![recruit(11, None), mv(2, 6, 1)],
                &w,
                &mut h
            ),
            SubmitError::MustBeAlone(ActionKind::Recruit),
            "{kind:?}"
        );
    }
}

/// BT3.2: every skill must be in the unit's kit, every bound id (skill target, item target,
/// recruit target) must be in the battle, and a Move destination must be on the board.
/// Kills: an unknown skill or id stored to fail later; an off-board tile accepted.
#[test]
fn skills_targets_and_destinations_must_exist_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 5);
    let mut b = gate_battle(&w, &mut h);
    let cases = [
        (
            vec![sk(999, 11)],
            SubmitError::UnknownSkill { skill_id: 999 },
        ),
        (vec![sk(LIGHT, 99)], SubmitError::UnknownTarget { id: 99 }),
        (
            vec![use_item(POTION, ActionTarget::Unit(99))],
            SubmitError::UnknownTarget { id: 99 },
        ),
        (
            vec![recruit(99, None)],
            SubmitError::UnknownTarget { id: 99 },
        ),
        (vec![mv(8, 0, 1)], SubmitError::OffBoard { x: 8, y: 0 }),
        (vec![mv(0, 8, 1)], SubmitError::OffBoard { x: 0, y: 8 }),
        (
            vec![mv(255, 255, 1)],
            SubmitError::OffBoard { x: 255, y: 255 },
        ),
    ];
    for (entries, want) in cases {
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, entries.clone(), &w, &mut h),
            want,
            "{entries:?}"
        );
    }
    submit(&mut b, T0, 2, vec![mv(7, 7, 1)], &w, &mut h);
    assert_eq!(
        entries_of(&b, 2),
        Some(vec![mv(7, 7, 1), END]),
        "the corner is on the board"
    );
}

/// BT3.2: the owner must hold every item in the quantity the plan uses — Item entries and bait
/// summed per item id against the OWNER's count (both player units share one bag).
/// Kills: one potion accepted for two uses; bait not counted; all item ids summed together.
#[test]
fn items_are_counted_per_item_against_the_owners_holding_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 1).holding(ETHER, 1);
    let mut b = gate_battle(&w, &mut h);
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![
                use_item(POTION, ActionTarget::SelfTarget),
                use_item(POTION, ActionTarget::SelfTarget)
            ],
            &w,
            &mut h
        ),
        SubmitError::ItemNotHeld {
            item_id: POTION,
            needed: 2,
            held: 1
        }
    );
    submit(
        &mut b,
        T0,
        2,
        vec![
            use_item(POTION, ActionTarget::SelfTarget),
            use_item(ETHER, ActionTarget::Unit(1)),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.plan(2).map(|p| p.entries.len()), Some(3));
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![recruit(11, Some(BAIT))],
            &w,
            &mut h
        ),
        SubmitError::ItemNotHeld {
            item_id: BAIT,
            needed: 1,
            held: 0
        },
        "the bait counts"
    );
    h.set_held(0, BAIT, 1);
    submit(&mut b, T0, 2, vec![recruit(11, Some(BAIT))], &w, &mut h);
    assert_eq!(entries_of(&b, 2), Some(vec![recruit(11, Some(BAIT)), END]));
}

/// BT3.2: a Recruit without party headroom is refused — before the bait is counted.
/// Kills: the headroom predicate skipped at submit; ItemNotHeld reported first.
#[test]
fn a_recruit_without_headroom_is_refused_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    h.headroom = false;
    assert_eq!(
        refused(&mut b, T0, Side::A, 2, vec![recruit(11, None)], &w, &mut h),
        SubmitError::NoHeadroom
    );
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![recruit(11, Some(BAIT))],
            &w,
            &mut h
        ),
        SubmitError::NoHeadroom,
        "NoHeadroom before ItemNotHeld"
    );
}

/// BT3.2: a pre-queue is costed from a FRESH budget (6) on the board as it stands: strides × 2 +
/// tiers + Exert + 3 × items, the stride cap 2, zero and hostile stride counts typed.
/// Kills: costing a pre-queue from the unit's idle budget (ap 0); Exert ignored; the stride cap
/// unchecked; a 255-stride Move trapping.
#[test]
fn a_pre_queue_is_costed_from_a_fresh_budget_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 3);
    let mut b = gate_battle(&w, &mut h);
    assert_eq!(
        unit_in(&b, 2).budget,
        TurnBudget::default(),
        "2 has not activated"
    );
    let econ = |e: EconomyError| SubmitError::Economy(e);
    let cases = [
        (
            vec![mv(2, 7, 2), sk(HEAVY, 11)],
            econ(EconomyError::Unaffordable { cost: 4, ap: 2 }),
        ),
        (
            vec![mv(2, 6, 3)],
            econ(EconomyError::StrideCap {
                used: 0,
                requested: 3,
                cap: 2,
            }),
        ),
        (
            vec![mv(2, 6, 1), mv(2, 7, 2)],
            econ(EconomyError::StrideCap {
                used: 1,
                requested: 2,
                cap: 2,
            }),
        ),
        (vec![mv(2, 6, 0)], econ(EconomyError::ZeroStrides)),
        (
            vec![mv(2, 6, 255)],
            econ(EconomyError::StrideCap {
                used: 0,
                requested: 255,
                cap: 2,
            }),
        ),
        (
            vec![sk(LIGHT, 11), sk(HEAVY, 11)],
            econ(EconomyError::Unaffordable { cost: 6, ap: 4 }),
        ),
        (
            vec![
                use_item(POTION, ActionTarget::SelfTarget),
                use_item(POTION, ActionTarget::SelfTarget),
                use_item(POTION, ActionTarget::SelfTarget),
            ],
            econ(EconomyError::Unaffordable { cost: 3, ap: 0 }),
        ),
    ];
    for (entries, want) in cases {
        assert_eq!(
            refused(&mut b, T0, Side::A, 2, entries.clone(), &w, &mut h),
            want,
            "{entries:?}"
        );
    }
    submit(&mut b, T0, 2, vec![sk(HEAVY, 11)], &w, &mut h);
    assert_eq!(
        entries_of(&b, 2),
        Some(vec![sk(HEAVY, 11), END]),
        "6 AP, not 0"
    );
    submit(
        &mut b,
        T0,
        2,
        vec![sk(LIGHT, 11), sk(LIGHT, 11)],
        &w,
        &mut h,
    );
    assert_eq!(
        entries_of(&b, 2),
        Some(vec![sk(LIGHT, 11), sk(LIGHT, 11), END]),
        "2 + Exert 4 = 6"
    );
    submit(&mut b, T0, 2, vec![mv(2, 7, 2), sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(b.plan(2).map(|p| p.entries.len()), Some(3), "4 + 2 = 6");
}

/// BT3.2: the disengage tax (+1) is charged for each Move whose start tile — the unit's tile,
/// then each previous Move's destination — is adjacent to a living enemy at submit.
///
/// ```text
///   1 A (0,0) waits    2 A (3,3) next to 11 B (4,3)    3 A (0,6)    12 B (7,0)    13 B (2,7)
/// ```
/// Kills: the tax judged at the unit's tile for every Move; judged at the Move's own
/// destination; never charged.
#[test]
fn the_disengage_tax_is_charged_on_each_moves_start_tile_at_submit_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 0, 0, 40),
            mon(2, Side::A, 1, 3, 3, 35),
            mon(11, Side::B, 0, 4, 3, 30),
            mon(3, Side::A, 2, 0, 6, 25),
            mon(12, Side::B, 1, 7, 0, 20),
            mon(13, Side::B, 2, 2, 7, 15),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    // Adjacent start: 2 + 1 + 4 = 7 > 6.
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![mv(3, 5, 1), sk(HEAVY, 11)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::Unaffordable { cost: 4, ap: 3 })
    );
    // The same plan shape from a free tile: 2 + 4 = 6.
    submit(&mut b, T0, 3, vec![mv(0, 4, 1), sk(HEAVY, 12)], &w, &mut h);
    assert_eq!(
        entries_of(&b, 3),
        Some(vec![mv(0, 4, 1), sk(HEAVY, 12), END])
    );
    // Safe start, but the first Move ends next to 13: the SECOND Move is taxed: 2 + 3 + 2 = 7.
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            3,
            vec![mv(1, 7, 1), mv(0, 5, 1), sk(LIGHT, 12)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::Unaffordable { cost: 2, ap: 1 })
    );
    submit(
        &mut b,
        T0,
        3,
        vec![mv(0, 4, 1), mv(0, 2, 1), sk(LIGHT, 12)],
        &w,
        &mut h,
    );
    assert_eq!(b.plan(3).map(|p| p.entries.len()), Some(4), "untaxed: 6");
}

/// BT3.2: a live submit is costed against the unit's CURRENT AP — after a live Light (4 AP
/// left, one attack made) a Heavy costs 4 + Exert 2 = 6 > 4, and a Recruit needs the full 6.
/// Kills: a live submit costed from a fresh budget.
#[test]
fn a_live_submit_is_costed_against_the_current_ap_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    submit(&mut b, T0 + 3_000, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(unit_in(&b, 1).budget.ap, 4);
    assert_eq!(
        refused(
            &mut b,
            T0 + 4_000,
            Side::A,
            1,
            vec![sk(HEAVY, 11)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::Unaffordable { cost: 6, ap: 4 })
    );
    assert_eq!(
        refused(
            &mut b,
            T0 + 4_000,
            Side::A,
            1,
            vec![sk(LIGHT, 11), sk(LIGHT, 11)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::Unaffordable { cost: 4, ap: 0 })
    );
    assert_eq!(
        refused(
            &mut b,
            T0 + 4_000,
            Side::A,
            1,
            vec![recruit(11, None)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::NeedsFullBudget { ap: 4, required: 6 })
    );
    let out = submit(&mut b, T0 + 5_000, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(out.actions, 1, "the second Light (4 AP) is affordable");
}

/// BT3.2: the gate reports the FIRST failure in the contract's order — Tuning → Act →
/// NotYourUnit → NotPlayerOwned → NoWindow → shape → MustBeAlone → per entry → NoHeadroom →
/// ItemNotHeld → costing → InvalidNow — pinned on plans that trip several rules at once.
/// Kills: per-entry checks before the shape pass; costing before the inventory; InvalidNow
/// before costing.
#[test]
fn the_submit_gate_reports_the_first_failure_in_contract_order_bt3_2() {
    let w = World::new();
    let bad = World::tuned(perturb(|t| t.guard_den = 0));
    let mut h = FakeHooks::new().holding(POTION, 1);
    let mut b = gate_battle(&w, &mut h);

    assert_eq!(
        refused(&mut b, T0, Side::B, 99, vec![], &bad, &mut h),
        SubmitError::Tuning(TuningError::ZeroGuardDen)
    );
    assert_eq!(
        refused(&mut b, T0, Side::B, 99, vec![END], &w, &mut h),
        SubmitError::Act(ActError::UnknownUnit(99))
    );
    assert_eq!(
        refused(&mut b, T0, Side::A, 11, vec![END], &w, &mut h),
        SubmitError::NotYourUnit,
        "NotYourUnit before NotPlayerOwned"
    );
    let mut closed = b.clone();
    closed.clocks[0].window_open_ms = None;
    closed.clocks[0].deadline_ms = None;
    assert_eq!(
        refused(&mut closed, T0, Side::A, 1, vec![], &w, &mut h),
        SubmitError::NoWindow,
        "NoWindow before Empty"
    );
    assert_eq!(
        refused(&mut b, T0, Side::A, 2, vec![sk(999, 99); 4], &w, &mut h),
        SubmitError::TooManyActions { count: 4 },
        "shape before the per-entry checks"
    );
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![END, FLEE, mv(2, 6, 1)],
            &w,
            &mut h
        ),
        SubmitError::EndTurnNotLast,
        "EndTurnNotLast before MustBeAlone"
    );
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![sk(999, 11), use_item(ETHER, ActionTarget::SelfTarget)],
            &w,
            &mut h
        ),
        SubmitError::UnknownSkill { skill_id: 999 },
        "UnknownSkill before ItemNotHeld"
    );
    assert_eq!(
        refused(&mut b, T0, Side::A, 2, vec![mv(9, 0, 3)], &w, &mut h),
        SubmitError::OffBoard { x: 9, y: 0 },
        "OffBoard before the stride cap"
    );
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            2,
            vec![use_item(POTION, ActionTarget::SelfTarget); 3],
            &w,
            &mut h
        ),
        SubmitError::ItemNotHeld {
            item_id: POTION,
            needed: 3,
            held: 1
        },
        "ItemNotHeld before Unaffordable"
    );
    assert_eq!(
        refused(
            &mut b,
            T0,
            Side::A,
            1,
            vec![sk(HEAVY, 12), sk(LIGHT, 12)],
            &w,
            &mut h
        ),
        SubmitError::Economy(EconomyError::Unaffordable { cost: 4, ap: 2 }),
        "costing before InvalidNow (12 is out of reach)"
    );
    assert_eq!(
        refused(&mut b, T0, Side::A, 1, vec![sk(HEAVY, 12)], &w, &mut h),
        SubmitError::InvalidNow {
            reason: HaltReason::Geometry(GeometryError::OutOfRange { distance: 8 })
        }
    );
}

/// BT3.2: only the owning side may submit for a unit, and only for a player-owned unit — a wild
/// never holds a plan.
/// Kills: the sender's side unchecked; a plan stored for a wild.
#[test]
fn only_the_owning_side_may_submit_for_a_player_unit_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    assert_eq!(
        refused(&mut b, T0, Side::B, 2, vec![END], &w, &mut h),
        SubmitError::NotYourUnit
    );
    assert_eq!(
        refused(&mut b, T0, Side::B, 11, vec![END], &w, &mut h),
        SubmitError::NotPlayerOwned
    );
    let (mut p, _) = drive(
        BattleKind::Pvp,
        vec![mon(1, Side::A, 0, 2, 2, 40), mon(11, Side::B, 0, 5, 2, 30)],
        &w,
        &mut h,
    );
    assert_eq!(
        refused(&mut p, T0, Side::B, 1, vec![END], &w, &mut h),
        SubmitError::NotYourUnit
    );
    assert_eq!(
        submit(&mut p, T0, 11, vec![END], &w, &mut h),
        quiet(1),
        "side B owns its units under the PvP ruleset"
    );
}

/// BT3.2: a fainted unit cannot submit (`Act(Fainted)`), and nothing can be submitted into a
/// finished battle (`Act(BattleOver)`).
/// Kills: a corpse's plan stored; submits accepted after the end.
#[test]
fn a_fainted_unit_or_a_finished_battle_refuses_every_submit_bt3_2() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    {
        let u = b.state.unit_mut(2).expect("unit 2");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
    }
    assert_eq!(
        refused(&mut b, T0, Side::A, 2, vec![END], &w, &mut h),
        SubmitError::Act(ActError::Fainted(2))
    );
    b.conclude(BattleOutcome::SideBWins, EndHow::Forfeit)
        .expect("the battle ends");
    assert_eq!(
        refused(&mut b, T0, Side::A, 3, vec![END], &w, &mut h),
        SubmitError::Act(ActError::BattleOver)
    );
}

// ===========================================================================
// BT3.3 — the execution gate (`validate_at_pop`, direct)
// ===========================================================================

/// A rules state with every listed actor's TurnStart done (fresh budgets).
fn pop_state(
    kind: BattleKind,
    overrides: &[(u8, u8, Terrain)],
    units: Vec<TacticalUnit>,
    actors: &[u32],
) -> TacticalState {
    let mut st = state_on(kind, 7, overrides, units);
    for &id in actors {
        turn_start(&mut st, id, &design()).expect("the actor can start");
    }
    st
}

fn pop(
    st: &TacticalState,
    unit: u32,
    action: QueuedAction,
    h: &FakeHooks,
) -> Result<Validated, HaltReason> {
    validate_at_pop(st, unit, &action, h, &design())
}

fn put(st: &mut TacticalState, id: u32, x: u8, y: u8) {
    st.unit_mut(id).expect("the unit exists").pos = c(x, y);
}

fn path(steps: &[(u8, u8)], cost: u16) -> Path {
    Path {
        steps: steps.iter().map(|&(x, y)| c(x, y)).collect(),
        cost,
    }
}

/// BT3.3: a Move is re-pathed on the live board — the cheapest path and the costed entry, with
/// the disengage tax judged on the LIVE board (an enemy that stepped next to the unit after
/// submit taxes the Move at pop) — and nothing is mutated or delegated.
/// Kills: the tax read from submit time; the client's path trusted; the budget spent by the gate.
#[test]
fn a_move_is_validated_on_the_live_board_with_the_live_tax_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 6, 6, 30)],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, mv(1, 3, 1), &h),
        Ok(Validated::Move {
            path: path(&[(1, 2), (1, 3)], 2),
            entry: Entry::Move {
                strides: 1,
                taxed: false
            },
        })
    );
    put(&mut st, 11, 0, 1);
    let before = st.clone();
    assert_eq!(
        pop(&st, 1, mv(1, 3, 1), &h),
        Ok(Validated::Move {
            path: path(&[(1, 2), (1, 3)], 2),
            entry: Entry::Move {
                strides: 1,
                taxed: true
            },
        })
    );
    assert_eq!(st, before);
    assert_eq!(st.unit(1).map(|u| u.budget), Some(fresh()));
    assert!(h.validate_log().is_empty(), "a Move never asks the hook");
}

/// BT3.3: a Move onto a tile that became occupied (an enemy, or an ally — no unit ever ends on
/// another) is invalid as a whole.
/// Kills: a partial walk to the last free tile; the destination re-picked.
#[test]
fn a_move_onto_a_tile_occupied_since_submit_is_invalid_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(2, Side::A, 1, 5, 5, 35),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, mv(3, 1, 1), &h),
        Ok(Validated::Move {
            path: path(&[(2, 1), (3, 1)], 2),
            entry: Entry::Move {
                strides: 1,
                taxed: false
            },
        })
    );
    put(&mut st, 11, 3, 1);
    assert_eq!(
        pop(&st, 1, mv(3, 1, 1), &h),
        Err(HaltReason::Path(PathError::DestOccupied))
    );
    put(&mut st, 11, 6, 6);
    put(&mut st, 2, 3, 1);
    assert_eq!(
        pop(&st, 1, mv(3, 1, 1), &h),
        Err(HaltReason::Path(PathError::DestOccupied)),
        "an ally on the destination"
    );
}

/// BT3.3: the only corridor (2,1) through a wall at x = 2: an ally standing in it is passed
/// through; an enemy standing in it makes the destination unreachable — the whole Move invalid.
/// Kills: a path through an enemy; an ally treated as a wall.
#[test]
fn a_move_whose_only_corridor_an_enemy_now_holds_is_unreachable_bt3_3() {
    let wall: Vec<(u8, u8, Terrain)> = (0..8u8)
        .filter(|&y| y != 1)
        .map(|y| (2, y, Terrain::Blocked))
        .collect();
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &wall,
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(2, Side::A, 1, 5, 5, 35),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
        &[1],
    );
    let through: Result<Validated, HaltReason> = Ok(Validated::Move {
        path: path(&[(2, 1), (3, 1)], 2),
        entry: Entry::Move {
            strides: 1,
            taxed: false,
        },
    });
    assert_eq!(pop(&st, 1, mv(3, 1, 1), &h), through);
    put(&mut st, 2, 2, 1);
    assert_eq!(pop(&st, 1, mv(3, 1, 1), &h), through, "an ally is passable");
    put(&mut st, 2, 5, 5);
    put(&mut st, 11, 2, 1);
    assert_eq!(
        pop(&st, 1, mv(3, 1, 1), &h),
        Err(HaltReason::Path(PathError::Unreachable))
    );
}

/// BT3.3: the cheapest live path must fit `strides × stride(base_speed)` stride points: a Walk
/// unit of base speed ≤ 49 (stride 2) crossing a Rough tile (weight 2) to a tile 2 away pays
/// 3 points for 2 → `TooFar { cost: 3, points: 2 }`; with 2 strides (4 points) it goes; a base-speed-50 unit
/// (stride 3) makes it on one stride; a unit with levelled speed 90 but base speed 40 does not.
/// Kills: stride read from the levelled speed; a hard-coded stride; Manhattan distance instead of
/// path cost; a partial walk.
#[test]
fn a_move_costing_more_stride_points_than_its_strides_buy_is_too_far_bt3_3() {
    let h = FakeHooks::new();
    let rough = [
        (2, 1, Terrain::Rough),
        (2, 3, Terrain::Rough),
        (2, 5, Terrain::Rough),
    ];
    let mut quick_levels = mon(2, Side::A, 1, 1, 5, 90);
    quick_levels.kit.base_speed = 40;
    let st = pop_state(
        BattleKind::Wild,
        &rough,
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            quick_levels,
            mon(3, Side::A, 2, 1, 3, 50),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
        &[1, 2, 3],
    );
    assert_eq!(
        pop(&st, 1, mv(3, 1, 1), &h),
        Err(HaltReason::TooFar { cost: 3, points: 2 })
    );
    assert_eq!(
        pop(&st, 1, mv(3, 1, 2), &h),
        Ok(Validated::Move {
            path: path(&[(2, 1), (3, 1)], 3),
            entry: Entry::Move {
                strides: 2,
                taxed: false
            },
        })
    );
    assert_eq!(
        pop(&st, 3, mv(3, 3, 1), &h),
        Ok(Validated::Move {
            path: path(&[(2, 3), (3, 3)], 3),
            entry: Entry::Move {
                strides: 1,
                taxed: false
            },
        }),
        "base speed 50 → stride 3"
    );
    assert_eq!(
        pop(&st, 2, mv(3, 5, 1), &h),
        Err(HaltReason::TooFar { cost: 3, points: 2 }),
        "stride comes from the BASE speed"
    );
}

/// BT3.3: a Move is re-costed against the live budget — zero strides, the stride cap (checked
/// before any stride math, a hostile 255 included) and affordability with the live tax.
/// Kills: the stride cap skipped at pop; a 255-stride multiplication trapping; the tax dropped.
#[test]
fn a_move_is_re_costed_against_the_live_budget_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 6, 6, 30)],
        &[1],
    );
    st.unit_mut(1).expect("unit 1").budget = TurnBudget {
        ap: 4,
        strides_used: 1,
        attacks: 0,
        last: Some(Entry::Move {
            strides: 1,
            taxed: false,
        }),
    };
    let econ = |e: EconomyError| -> Result<Validated, HaltReason> { Err(HaltReason::Economy(e)) };
    assert_eq!(
        pop(&st, 1, mv(1, 3, 2), &h),
        econ(EconomyError::StrideCap {
            used: 1,
            requested: 2,
            cap: 2
        })
    );
    assert_eq!(
        pop(&st, 1, mv(1, 3, 255), &h),
        econ(EconomyError::StrideCap {
            used: 1,
            requested: 255,
            cap: 2
        })
    );
    assert_eq!(
        pop(&st, 1, mv(1, 3, 0), &h),
        econ(EconomyError::ZeroStrides)
    );
    st.unit_mut(1).expect("unit 1").budget = TurnBudget {
        ap: 2,
        strides_used: 0,
        attacks: 1,
        last: Some(Entry::Attack(Tier::Heavy)),
    };
    put(&mut st, 11, 0, 1);
    assert_eq!(
        pop(&st, 1, mv(1, 3, 1), &h),
        econ(EconomyError::Unaffordable { cost: 3, ap: 2 }),
        "2 + the live tax 1 > 2"
    );
}

/// BT3.3: a Skill re-centres on its bound unit's CURRENT tile and recomputes the targets through
/// the one geometry function — the client's tile is never read.
/// Kills: the aim frozen at submit; targets cached from submit; a second targeting rule.
#[test]
fn a_skill_re_centres_on_its_bound_units_current_tile_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(11, Side::B, 0, 3, 1, 30),
            mon(12, Side::B, 1, 3, 2, 20),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, sk(SPLASH, 11), &h),
        Ok(Validated::Skill {
            skill_id: SPLASH,
            aim: c(3, 1),
            targets: vec![11, 12],
        })
    );
    put(&mut st, 11, 2, 3);
    let want =
        target_set(&diamond(FfFilter::Enemies, 3), 1, c(2, 3), &st.board()).expect("in range");
    assert_eq!(want, vec![11]);
    assert_eq!(
        pop(&st, 1, sk(SPLASH, 11), &h),
        Ok(Validated::Skill {
            skill_id: SPLASH,
            aim: c(2, 3),
            targets: want,
        })
    );
}

/// BT3.3: a Skill bound to a fainted or missing unit is `TargetGone`; one whose bound unit moved
/// out of range is a `Geometry` halt with the live distance.
/// Kills: a corpse's tile used as the aim; the range checked against the submit-time tile.
#[test]
fn a_skill_bound_to_a_gone_or_distant_unit_is_invalid_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(11, Side::B, 0, 3, 1, 30),
            mon(12, Side::B, 1, 3, 2, 20),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, sk(LIGHT, 11), &h),
        Err(HaltReason::Geometry(GeometryError::OutOfRange {
            distance: 2
        })),
        "melee at distance 2"
    );
    put(&mut st, 11, 6, 6);
    assert_eq!(
        pop(&st, 1, sk(SPLASH, 11), &h),
        Err(HaltReason::Geometry(GeometryError::OutOfRange {
            distance: 10
        }))
    );
    {
        let u = st.unit_mut(12).expect("unit 12");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
    }
    assert_eq!(
        pop(&st, 1, sk(SPLASH, 12), &h),
        Err(HaltReason::TargetGone { id: 12 })
    );
    assert_eq!(
        pop(&st, 1, sk(SPLASH, 99), &h),
        Err(HaltReason::TargetGone { id: 99 })
    );
}

/// BT3.3: `SelfTarget` aims at the caster's own tile — a caster ring finds the adjacent enemy;
/// a target-unit melee skill aimed at oneself is out of its minimum range (distance 0).
/// Kills: SelfTarget resolved to some other unit's tile.
#[test]
fn a_self_targeted_skill_aims_at_the_caster_bt3_3() {
    let h = FakeHooks::new();
    let st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(11, Side::B, 0, 2, 1, 30),
            mon(12, Side::B, 1, 5, 5, 20),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, sk_self(NOVA), &h),
        Ok(Validated::Skill {
            skill_id: NOVA,
            aim: c(1, 1),
            targets: vec![11],
        })
    );
    assert_eq!(
        pop(&st, 1, sk_self(LIGHT), &h),
        Err(HaltReason::Geometry(GeometryError::OutOfRange {
            distance: 0
        }))
    );
}

/// BT3.3: a Skill is re-costed against the LIVE budget with Exert (after a Light, a Heavy costs
/// 6 > 4) before the geometry is computed, and an unknown skill is refused first.
/// Kills: a fresh budget at pop; Exert dropped; geometry reported before affordability.
#[test]
fn a_skill_is_re_costed_against_the_live_budget_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(11, Side::B, 0, 2, 1, 30),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
        &[1],
    );
    st.unit_mut(1).expect("unit 1").budget = TurnBudget {
        ap: 4,
        strides_used: 0,
        attacks: 1,
        last: Some(Entry::Attack(Tier::Light)),
    };
    let unaffordable: Result<Validated, HaltReason> =
        Err(HaltReason::Economy(EconomyError::Unaffordable {
            cost: 6,
            ap: 4,
        }));
    assert_eq!(pop(&st, 1, sk(HEAVY, 11), &h), unaffordable);
    assert_eq!(
        pop(&st, 1, sk(HEAVY, 12), &h),
        unaffordable,
        "affordability before geometry"
    );
    assert_eq!(
        pop(&st, 1, sk(LIGHT, 11), &h),
        Ok(Validated::Skill {
            skill_id: LIGHT,
            aim: c(2, 1),
            targets: vec![11],
        })
    );
    assert_eq!(
        pop(&st, 1, sk(999, 11), &h),
        Err(HaltReason::UnknownSkill { skill_id: 999 })
    );
}

/// BT3.3: an Item re-reads the OWNER's live count through the hook (once, with the actor and
/// the item), resolves `SelfTarget` to the actor and `Unit(id)` to that id, re-costs 3 AP, and
/// hands the validated facts to `validate_delegated`; a count that dropped to 0 since submit is
/// `ItemNotHeld`.
/// Kills: the inventory read at submit only; SelfTarget left unresolved; the delegated check
/// skipped.
#[test]
fn an_item_re_reads_the_owners_inventory_through_the_hook_bt3_3() {
    let mut h = FakeHooks::new().holding(POTION, 1);
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(2, Side::A, 1, 1, 3, 35),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
        &[1, 2, 11],
    );
    let item_on = |target: u32| Validated::Item {
        item_id: POTION,
        target,
        entry: Entry::Item,
    };
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::SelfTarget), &h),
        Ok(item_on(1))
    );
    assert_eq!(h.item_count_log(), vec![(1, POTION)], "read once, at pop");
    assert_eq!(h.validate_log(), vec![(1, item_on(1))]);
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::Unit(2)), &h),
        Ok(item_on(2))
    );
    assert_eq!(
        pop(&st, 2, use_item(POTION, ActionTarget::SelfTarget), &h),
        Ok(item_on(2)),
        "unit 2 reads the same owner's bag"
    );
    assert!(h.take_calls.is_empty(), "the gate never debits");

    h.set_held(0, POTION, 0);
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::SelfTarget), &h),
        Err(HaltReason::ItemNotHeld { item_id: POTION })
    );
    h.set_held(0, POTION, 1);
    assert_eq!(
        pop(&st, 11, use_item(POTION, ActionTarget::SelfTarget), &h),
        Err(HaltReason::NotAllowed(ActionKind::Item)),
        "a wild never uses items"
    );
    {
        let u = st.unit_mut(2).expect("unit 2");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
    }
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::Unit(2)), &h),
        Err(HaltReason::TargetGone { id: 2 })
    );
    st.unit_mut(1).expect("unit 1").budget.ap = 2;
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::SelfTarget), &h),
        Err(HaltReason::Economy(EconomyError::Unaffordable {
            cost: 3,
            ap: 2
        }))
    );
}

/// BT3.3: a delegated refusal is surfaced unchanged for Item, Recruit and Flee, and the hook is
/// consulted for those kinds only — never for Move, Skill or EndTurn.
/// Kills: the refusal remapped; the hook asked about every entry; the hook skipped for Flee.
#[test]
fn a_delegated_refusal_is_surfaced_unchanged_for_delegated_kinds_only_bt3_3() {
    let refusal = HaltReason::Geometry(GeometryError::OutOfRange { distance: 9 });
    let mut h = FakeHooks::new().holding(POTION, 1).holding(BAIT, 1);
    h.refuse = Some(refusal);
    let st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 3, 3, 40),
            mon(11, Side::B, 0, 4, 3, 30),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, use_item(POTION, ActionTarget::SelfTarget), &h),
        Err(refusal)
    );
    assert_eq!(pop(&st, 1, recruit(11, Some(BAIT)), &h), Err(refusal));
    assert_eq!(pop(&st, 1, FLEE, &h), Err(refusal));
    assert_eq!(
        h.validate_log(),
        vec![
            (
                1,
                Validated::Item {
                    item_id: POTION,
                    target: 1,
                    entry: Entry::Item,
                }
            ),
            (
                1,
                Validated::Recruit {
                    target: 11,
                    bait: Some(BAIT),
                    entry: Entry::Recruit,
                }
            ),
            (1, Validated::Flee { entry: Entry::Flee }),
        ]
    );
    assert!(pop(&st, 1, mv(3, 5, 1), &h).is_ok());
    assert!(pop(&st, 1, sk(LIGHT, 11), &h).is_ok());
    assert_eq!(pop(&st, 1, END, &h), Ok(Validated::EndTurn));
    assert_eq!(
        h.validate_log().len(),
        3,
        "Move/Skill/EndTurn never consult the hook"
    );
}

/// BT3.3: a Recruit re-checks, in order: the target conscious (`TargetGone`), wild (`NotWild`),
/// adjacent (`NotAdjacent`), headroom (`NoHeadroom`), the bait held (`ItemNotHeld`), the full
/// budget (`NeedsFullBudget`).
///
/// ```text
///   1 A (3,3) actor   2 A (3,4) adjacent ally   3 A (0,7) far ally   11 B (4,3) adjacent   12 B (6,6)
/// ```
/// Kills: adjacency judged at submit; a player unit recruited; headroom or the bait skipped at pop.
#[test]
fn a_recruit_rechecks_target_adjacency_headroom_bait_and_budget_bt3_3() {
    let mut h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![
            mon(1, Side::A, 0, 3, 3, 40),
            mon(2, Side::A, 1, 3, 4, 35),
            mon(3, Side::A, 2, 0, 7, 25),
            mon(11, Side::B, 0, 4, 3, 30),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
        &[1],
    );
    assert_eq!(
        pop(&st, 1, recruit(11, None), &h),
        Ok(Validated::Recruit {
            target: 11,
            bait: None,
            entry: Entry::Recruit,
        })
    );
    assert_eq!(
        pop(&st, 1, recruit(12, None), &h),
        Err(HaltReason::NotAdjacent { target: 12 })
    );
    assert_eq!(
        pop(&st, 1, recruit(2, None), &h),
        Err(HaltReason::NotWild { target: 2 })
    );
    assert_eq!(
        pop(&st, 1, recruit(3, None), &h),
        Err(HaltReason::NotWild { target: 3 }),
        "NotWild before NotAdjacent"
    );
    assert_eq!(
        pop(&st, 1, recruit(99, None), &h),
        Err(HaltReason::TargetGone { id: 99 })
    );
    h.headroom = false;
    assert_eq!(
        pop(&st, 1, recruit(11, None), &h),
        Err(HaltReason::NoHeadroom)
    );
    assert_eq!(
        pop(&st, 1, recruit(12, None), &h),
        Err(HaltReason::NotAdjacent { target: 12 }),
        "NotAdjacent before NoHeadroom"
    );
    h.headroom = true;
    assert_eq!(
        pop(&st, 1, recruit(11, Some(BAIT)), &h),
        Err(HaltReason::ItemNotHeld { item_id: BAIT })
    );
    h.set_held(0, BAIT, 1);
    assert_eq!(
        pop(&st, 1, recruit(11, Some(BAIT)), &h),
        Ok(Validated::Recruit {
            target: 11,
            bait: Some(BAIT),
            entry: Entry::Recruit,
        })
    );
    st.unit_mut(1).expect("unit 1").budget.ap = 4;
    assert_eq!(
        pop(&st, 1, recruit(11, None), &h),
        Err(HaltReason::Economy(EconomyError::NeedsFullBudget {
            ap: 4,
            required: 6
        }))
    );
    st.unit_mut(1).expect("unit 1").budget.ap = 6;
    {
        let u = st.unit_mut(11).expect("unit 11");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
    }
    assert_eq!(
        pop(&st, 1, recruit(11, None), &h),
        Err(HaltReason::TargetGone { id: 11 })
    );
}

/// BT3.3: Recruit and Flee are `NotAllowed` under the PvP ruleset; a wild may use no Item,
/// Recruit or Flee; a player's Flee in a wild battle needs the full budget.
/// Kills: Flee allowed in PvP; a wild actor handed to the delegated rules.
#[test]
fn recruit_and_flee_are_not_allowed_in_pvp_or_for_a_wild_bt3_3() {
    let h = FakeHooks::new().holding(POTION, 1);
    let pvp = pop_state(
        BattleKind::Pvp,
        &[],
        vec![mon(1, Side::A, 0, 3, 3, 40), mon(11, Side::B, 0, 4, 3, 30)],
        &[1],
    );
    assert_eq!(
        pop(&pvp, 1, recruit(11, None), &h),
        Err(HaltReason::NotAllowed(ActionKind::Recruit))
    );
    assert_eq!(
        pop(&pvp, 1, FLEE, &h),
        Err(HaltReason::NotAllowed(ActionKind::Flee))
    );
    assert_eq!(
        pop(&pvp, 1, use_item(POTION, ActionTarget::SelfTarget), &h),
        Ok(Validated::Item {
            item_id: POTION,
            target: 1,
            entry: Entry::Item,
        }),
        "items are allowed under the PvP ruleset"
    );

    let mut wild_st = pop_state(
        BattleKind::Wild,
        &[],
        vec![mon(1, Side::A, 0, 3, 3, 40), mon(11, Side::B, 0, 4, 3, 30)],
        &[1, 11],
    );
    assert_eq!(
        pop(&wild_st, 11, use_item(POTION, ActionTarget::SelfTarget), &h),
        Err(HaltReason::NotAllowed(ActionKind::Item))
    );
    assert_eq!(
        pop(&wild_st, 11, recruit(1, None), &h),
        Err(HaltReason::NotAllowed(ActionKind::Recruit))
    );
    assert_eq!(
        pop(&wild_st, 11, FLEE, &h),
        Err(HaltReason::NotAllowed(ActionKind::Flee))
    );
    assert_eq!(
        pop(&wild_st, 1, FLEE, &h),
        Ok(Validated::Flee { entry: Entry::Flee })
    );
    wild_st.unit_mut(1).expect("unit 1").budget.ap = 4;
    assert_eq!(
        pop(&wild_st, 1, FLEE, &h),
        Err(HaltReason::Economy(EconomyError::NeedsFullBudget {
            ap: 4,
            required: 6
        }))
    );
}

/// BT3.3: the hostile-state guards run on every kind: an unusable tuning (`Tuning`) before a
/// unit that cannot act (`Act`) before a unit row the pipeline cannot run on (`BadUnit`) — the
/// actor's (any kind, EndTurn included) and every skill target's.
/// Kills: `validate_unit` skipped for targets or for non-attack kinds; the order swapped.
#[test]
fn the_execution_gate_refuses_hostile_rows_and_tunings_bt3_3() {
    let h = FakeHooks::new();
    let base = pop_state(
        BattleKind::Wild,
        &[],
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 2, 1, 30)],
        &[1],
    );
    let mut st = base.clone();
    st.unit_mut(11).expect("unit 11").kit.stats.defense = 0;
    assert_eq!(
        pop(&st, 1, sk(LIGHT, 11), &h),
        Err(HaltReason::BadUnit(DeployError::ZeroDefense { id: 11 }))
    );

    let mut st = base.clone();
    st.unit_mut(1).expect("unit 1").kit.stats.defense = 0;
    for action in [END, mv(1, 3, 1), sk(LIGHT, 11)] {
        assert_eq!(
            pop(&st, 1, action, &h),
            Err(HaltReason::BadUnit(DeployError::ZeroDefense { id: 1 })),
            "{action:?}"
        );
    }

    let mut st = base.clone();
    st.unit_mut(1).expect("unit 1").cur_hp = 101;
    assert_eq!(
        pop(&st, 1, END, &h),
        Err(HaltReason::BadUnit(DeployError::HpAboveMax {
            id: 1,
            cur_hp: 101,
            max_hp: 100
        }))
    );

    let mut st = base.clone();
    {
        let u = st.unit_mut(1).expect("unit 1");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
        u.kit.stats.defense = 0;
    }
    assert_eq!(
        pop(&st, 1, END, &h),
        Err(HaltReason::Act(ActError::Fainted(1))),
        "Act before BadUnit"
    );
    let bad = perturb(|t| t.flank_den = 0);
    assert_eq!(
        validate_at_pop(&st, 1, &END, &h, &bad),
        Err(HaltReason::Tuning(TuningError::ZeroFlankDen)),
        "Tuning before Act"
    );
    let mut over = base;
    over.outcome = BattleOutcome::SideBWins;
    assert_eq!(
        pop(&over, 1, END, &h),
        Err(HaltReason::Act(ActError::BattleOver))
    );
}

/// BT3.3: `EndTurn` is valid for any unit that can act, even with no AP left.
/// Kills: EndTurn costed against the floor; EndTurn sent to the hook.
#[test]
fn an_end_turn_is_always_valid_for_a_unit_that_can_act_bt3_3() {
    let h = FakeHooks::new();
    let mut st = pop_state(
        BattleKind::Wild,
        &[],
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 6, 6, 30)],
        &[1],
    );
    st.unit_mut(1).expect("unit 1").budget.ap = 0;
    assert_eq!(pop(&st, 1, END, &h), Ok(Validated::EndTurn));
    assert!(h.validate_log().is_empty());
}

// ===========================================================================
// BT3.4 — the executor: halt-and-return, drains, the shape check, self-KO
// ===========================================================================

/// Wild, waiting on 1: 1 A (3,3) speed 40 next to 11 B (4,3) speed 30; 17 B (7,7) speed 20 is
/// out of every melee reach.
fn halt_fixture(w: &World, h: &mut FakeHooks) -> TacticalBattle {
    let (b, out) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 3, 3, 40),
            mon(11, Side::B, 0, 4, 3, 30),
            mon(17, Side::B, 1, 7, 7, 20),
        ],
        w,
        h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1), "{out:?}");
    b
}

/// BT3.4: `[Light → 11, TAIL → 17 (out of reach), EndTurn]` live: the Light executes, the TAIL
/// halts at idx 1 with `Geometry`, the EndTurn never runs, 0 AP is charged for the halt (the
/// budget is exactly the one-Light budget) and the unit gets the rest back live in a FRESH window.
/// Kills: continuing past the invalid entry (the EndTurn would end the turn); AP charged for the
/// halted entry; the window not reopened; a double spend of the Light.
#[test]
fn a_halt_discards_the_failed_entry_and_the_tail_and_charges_nothing_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = halt_fixture(&w, &mut h);
    let t1 = T0 + 9_000;
    let out = submit(
        &mut b,
        t1,
        1,
        vec![sk(LIGHT, 11), sk(TAIL, 17), END],
        &w,
        &mut h,
    );
    assert_eq!(
        out,
        StepResult {
            events: vec![
                executed(1, LIGHT, vec![chip(11)]),
                halted(1, 1, HaltKind::Geometry),
            ],
            round: 1,
            window: Some(Window {
                seq: 2,
                opens_at_ms: t1 + 400,
                deadline_ms: t1 + 400 + PVE_MS,
            }),
            unit_turns: 1,
            actions: 1,
        }
    );
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 4,
            strides_used: 0,
            attacks: 1,
            last: Some(Entry::Attack(Tier::Light)),
        }
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(b.clocks[0].windows_this_unit_turn, 2);
    assert_eq!((unit_in(&b, 11).cur_hp, unit_in(&b, 17).cur_hp), (99, 100));
}

/// BT3.4: a pre-queued halt below the AP floor ends the turn COMMITTED and the round goes on.
/// 11 (first) walks next to 1 after 1 queued `[Move, Move, Light → 11]` (6 AP untaxed at
/// submit); at pop the first Move pays the live tax (3), the second 2, and the Light (2) is
/// unaffordable with 1 AP: `PlanHalted{1, 2, Unaffordable}`, `TurnEnded{1, guard false,
/// committed true}`, then 2 starts and waits.
/// Kills: halt-and-return with < 2 AP; the halt ending the turn uncommitted; the tax read from
/// submit time; the next unit not started.
#[test]
fn a_halt_below_the_ap_floor_ends_the_turn_committed_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![mv(2, 1, 1), END]);
    let mut b = wild(vec![
        mon(11, Side::B, 0, 4, 1, 45),
        mon(1, Side::A, 0, 1, 1, 40),
        mon(2, Side::A, 1, 6, 6, 30),
    ]);
    submit(
        &mut b,
        T0 - 100,
        1,
        vec![mv(1, 3, 1), mv(1, 5, 1), sk(LIGHT, 11)],
        &w,
        &mut h,
    );
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            moved(11, (4, 1), (2, 1), 2),
            ended(11, true, true),
            moved(1, (1, 1), (1, 3), 2),
            moved(1, (1, 3), (1, 5), 2),
            halted(1, 2, HaltKind::Unaffordable),
            ended(1, false, true),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!((out.unit_turns, out.actions), (3, 3));
    assert_eq!(unit_in(&b, 1).pos, c(1, 5));
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget::default(),
        "the turn ended"
    );
    assert_eq!(b.plan(1), None);
}

/// BT3.4: a halt at exactly 2 AP still returns control live (the floor is `≥ 2`).
/// Kills: `ap > min_action_cost`.
#[test]
fn a_halt_at_exactly_the_ap_floor_returns_control_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 3), (6, 6), &w, &mut h);
    let t1 = T0 + 4_000;
    let out = submit(&mut b, t1, 1, vec![mv(5, 3, 2), sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            moved(1, (1, 3), (5, 3), 4),
            halted(1, 1, HaltKind::Geometry),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1 + 400,
            deadline_ms: t1 + 400 + PVE_MS,
        })
    );
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 2,
            strides_used: 2,
            attacks: 0,
            last: Some(Entry::Move {
                strides: 2,
                taxed: false
            }),
        }
    );
}

/// BT3.4: a halt in an AI plan ends the wild's turn committed — the wild never waits.
/// Kills: a wild entering `Waiting`; an AI halt ending the turn uncommitted.
#[test]
fn a_halt_in_an_ai_plan_ends_the_wilds_turn_committed_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![sk(LIGHT, 1), END]);
    let (b, out) = drive(
        BattleKind::Wild,
        vec![mon(11, Side::B, 0, 6, 6, 45), mon(1, Side::A, 0, 1, 1, 40)],
        &w,
        &mut h,
    );
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            halted(11, 0, HaltKind::Geometry),
            ended(11, true, true),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(unit_in(&b, 11).budget, TurnBudget::default());
}

/// BT3.4: halt-and-return applies to pre-queued plans too: 1 queued a Light on an adjacent 11,
/// 11 walked away first, the Light halts at idx 0 and 1 gets its full 6 AP back live.
/// Kills: a pre-queued halt always ending the turn.
#[test]
fn a_pre_queued_halt_with_ap_to_spare_returns_control_live_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![mv(6, 3, 1), END]);
    let mut b = wild(vec![
        mon(11, Side::B, 0, 4, 3, 45),
        mon(1, Side::A, 0, 3, 3, 40),
    ]);
    submit(&mut b, T0 - 100, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            moved(11, (4, 3), (6, 3), 2),
            ended(11, true, true),
            halted(1, 0, HaltKind::Geometry),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_200,
            deadline_ms: T0 + 2_200 + PVE_MS,
        })
    );
    assert_eq!(unit_in(&b, 1).budget, fresh(), "nothing charged");
    assert_eq!(b.plan(1), None, "the row was consumed at TurnStart");
}

/// BT3.4: a drained pre-queued plan ends the turn committed with the Guard its budget earns —
/// a Move then the EndTurn → Guard; an attack → no Guard; a drained AI plan ends committed.
/// Kills: a drain ending uncommitted; Guard granted after an attack or denied after a Move.
#[test]
fn a_drained_pre_queued_or_ai_plan_ends_the_turn_committed_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 45),
        mon(2, Side::A, 1, 5, 1, 40),
        mon(11, Side::B, 0, 7, 7, 30),
    ]);
    submit(&mut b, T0 - 100, 1, vec![mv(1, 3, 1)], &w, &mut h);
    submit(&mut b, T0 - 100, 2, vec![sk_self(NOVA)], &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            moved(1, (1, 1), (1, 3), 2),
            ended(1, true, true),
            executed(2, NOVA, vec![]),
            ended(2, false, true),
            ended(11, true, true),
            round_ended(1),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!((out.unit_turns, out.actions), (3, 2));
    assert!(unit_in(&b, 1).guard);
    assert!(!unit_in(&b, 2).guard);
}

/// BT3.4: a live `[Light]` spends 2 AP ONCE (resolve_attack already spends: 4 left, not 2),
/// emits only its own events and re-enters `Waiting(1)` with a fresh window.
/// Kills: the executor spending the attack a second time; a live submit normalised with an
/// appended EndTurn (the turn would end).
#[test]
fn a_live_light_leaves_four_ap_and_returns_control_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    let t1 = T0 + 9_000;
    let out = submit(&mut b, t1, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out,
        StepResult {
            events: vec![executed(1, LIGHT, vec![chip(11)])],
            round: 1,
            window: Some(Window {
                seq: 2,
                opens_at_ms: t1 + 400,
                deadline_ms: t1 + 400 + PVE_MS,
            }),
            unit_turns: 1,
            actions: 1,
        }
    );
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 4,
            strides_used: 0,
            attacks: 1,
            last: Some(Entry::Attack(Tier::Light)),
        }
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

/// BT3.4: a live plan ending in `EndTurn` ends the turn committed (Guard per the budget: none
/// after an attack, granted after a Move) and the round continues to its upkeep.
/// Kills: a trailing EndTurn ignored on a live submit; Guard ignoring the attack.
#[test]
fn a_live_plan_ending_in_end_turn_ends_the_turn_committed_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    let out = submit(&mut b, T0 + 9_000, 1, vec![sk(LIGHT, 11), END], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            executed(1, LIGHT, vec![chip(11)]),
            ended(1, false, true),
            ended(11, true, true),
            round_ended(1),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(out.window, None);

    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 3), (6, 3), &w, &mut h);
    let out = submit(&mut b, T0 + 9_000, 1, vec![mv(3, 3, 1), END], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            moved(1, (1, 3), (3, 3), 2),
            ended(1, true, true),
            ended(11, true, true),
            round_ended(1),
        ]
    );
}

/// BT3.4: a live `[Move, Move]` leaves 2 AP and re-enters `Waiting`; a later live `[Light]`
/// spends the last 2 and, below the floor, ends the turn committed instead of waiting.
/// Kills: `Waiting` re-entered with 0 AP; the turn ended with 2 AP left.
#[test]
fn a_live_drain_below_the_ap_floor_ends_the_turn_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 3), (6, 3), &w, &mut h);
    let t1 = T0 + 5_000;
    let out = submit(&mut b, t1, 1, vec![mv(3, 3, 1), mv(5, 3, 1)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![moved(1, (1, 3), (3, 3), 2), moved(1, (3, 3), (5, 3), 2)]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1 + 400,
            deadline_ms: t1 + 400 + PVE_MS,
        })
    );
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 2,
            strides_used: 2,
            attacks: 0,
            last: Some(Entry::Move {
                strides: 1,
                taxed: false
            }),
        }
    );
    let out = submit(&mut b, t1 + 1_000, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            executed(1, LIGHT, vec![chip(11)]),
            ended(1, false, true),
            ended(11, true, true),
            round_ended(1),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
}

/// BT3.4: an Item entry debits once (`take_item` exactly once), spends 3 AP, emits `ItemUsed`
/// BEFORE the hook's own events, and the hook's effect (a 20-HP heal) lands.
/// Kills: no debit or a double debit; ItemUsed after the hook's events; the effect skipped.
#[test]
fn an_item_entry_debits_once_and_emits_item_used_before_the_hooks_events_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 1);
    h.extra = vec![awards(1)];
    let mut b = drive_to_waiting((1, 1), (6, 6), &w, &mut h);
    b.state.unit_mut(1).expect("unit 1").cur_hp = 50;
    let t1 = T0 + 3_000;
    let out = submit(
        &mut b,
        t1,
        1,
        vec![use_item(POTION, ActionTarget::SelfTarget)],
        &w,
        &mut h,
    );
    assert_eq!(out.events, vec![item_used(1, POTION, 1), awards(1)]);
    assert_eq!(h.take_calls, vec![(1, POTION)]);
    assert_eq!(
        h.resolve_calls,
        vec![(
            1,
            Validated::Item {
                item_id: POTION,
                target: 1,
                entry: Entry::Item,
            }
        )]
    );
    assert_eq!(h.held(0, POTION), 0);
    assert_eq!(unit_in(&b, 1).cur_hp, 70);
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 3,
            strides_used: 0,
            attacks: 0,
            last: Some(Entry::Item),
        }
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(out.actions, 1);
}

/// BT3.4: events a delegated resolver forges outside its allowed kinds (BattleEnd, PlanHalted,
/// TurnEnded, QueueVoided, AutoPass, RoundEnded, BattleStarted, Executed, Missed, StoodGround,
/// Surge) are dropped — they reach neither the event list nor the clock pad — while an allowed
/// kind (Awards) is kept.
/// Kills: the hook's events passed through unfiltered.
#[test]
fn events_forged_by_a_delegated_resolver_are_dropped_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 1);
    h.extra = vec![
        battle_end(BattleOutcome::SideAWins, EndHow::SideEmpty),
        awards(1),
        halted(1, 0, HaltKind::BadShape),
        ended(1, true, true),
        voided(1),
        auto_pass(1, 1),
        round_ended(9),
        battle_started(9),
        executed(1, LIGHT, vec![]),
        EventPayload::Missed(MissedEvent {
            attacker: 1,
            target: 11,
        }),
        EventPayload::StoodGround(StoodGroundEvent { unit: 1 }),
        EventPayload::Surge(SurgeEvent {
            round: 9,
            unit: 1,
            amount: 5,
        }),
    ];
    let mut b = drive_to_waiting((1, 1), (6, 6), &w, &mut h);
    let t1 = T0 + 3_000;
    let out = submit(
        &mut b,
        t1,
        1,
        vec![use_item(POTION, ActionTarget::SelfTarget)],
        &w,
        &mut h,
    );
    assert_eq!(out.events, vec![item_used(1, POTION, 1), awards(1)]);
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1 + 400,
            deadline_ms: t1 + 400 + PVE_MS,
        }),
        "only ItemUsed pads the window"
    );
    assert_eq!(b.state.outcome, BattleOutcome::Ongoing);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

/// BT3.4: the shape check runs for EVERY origin — an AI plan of 4 actions, with a Flee, an
/// Item or a Recruit, or with a non-terminal EndTurn halts at idx 0 with `BadShape` (nothing
/// executes, nothing is delegated) and the wild's turn ends committed.
/// Kills: AI plans trusted; a 4th AI action executed; an AI Item handed to the hooks.
#[test]
fn an_ai_plan_of_the_wrong_shape_halts_at_its_first_entry_bt3_4() {
    let w = World::new();
    let bad_plans = [
        vec![mv(6, 5, 1), mv(6, 4, 1), mv(6, 3, 1), mv(6, 2, 1)],
        vec![FLEE],
        vec![use_item(POTION, ActionTarget::SelfTarget)],
        vec![recruit(1, None)],
        vec![END, mv(6, 5, 1)],
    ];
    for plan in bad_plans {
        let mut h = FakeHooks::new()
            .holding(POTION, 1)
            .ai_plan(11, plan.clone());
        let (b, out) = drive(
            BattleKind::Wild,
            vec![mon(11, Side::B, 0, 6, 6, 45), mon(1, Side::A, 0, 1, 1, 40)],
            &w,
            &mut h,
        );
        assert_eq!(
            out.events,
            vec![
                battle_started(1),
                halted(11, 0, HaltKind::BadShape),
                ended(11, true, true),
            ],
            "{plan:?}"
        );
        assert_eq!(unit_in(&b, 11).pos, c(6, 6), "{plan:?}");
        assert_eq!(h.plan_ai_log(), vec![11]);
        assert!(
            h.take_calls.is_empty() && h.resolve_calls.is_empty(),
            "{plan:?}"
        );
        assert_eq!(b.turn_state, TurnState::Waiting(1));
    }
}

/// BT3.4: an EMPTY AI plan drains at once: the wild's turn ends committed, no halt, no panic.
/// Kills: `entries.last().unwrap()` / `entries[0]` on an empty plan.
#[test]
fn an_empty_ai_plan_ends_the_wilds_turn_committed_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![]);
    let (b, out) = drive(
        BattleKind::Wild,
        vec![mon(11, Side::B, 0, 6, 6, 45), mon(1, Side::A, 0, 1, 1, 40)],
        &w,
        &mut h,
    );
    assert_eq!(out.events, vec![battle_started(1), ended(11, true, true)]);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

/// BT3.4: an actor that KOs itself (an `All`-filter diamond around itself at 1 HP) discards the
/// rest of its plan and ends its turn UNCOMMITTED without `turn_end` (no Guard, its budget left
/// as the attack left it); the round goes on with the next unit.
/// Kills: the Move after the self-KO executed; the turn ended committed; the round stalled.
#[test]
fn an_actor_that_kos_itself_ends_its_turn_uncommitted_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            with_hp(mon(1, Side::A, 0, 3, 3, 40), 1),
            mon(11, Side::B, 0, 7, 0, 30),
            mon(2, Side::A, 1, 0, 7, 20),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let t1 = T0 + 6_000;
    let out = submit(
        &mut b,
        t1,
        1,
        vec![sk_self(SELF_NOVA), mv(3, 5, 1)],
        &w,
        &mut h,
    );
    assert_eq!(
        out.events,
        vec![
            executed(1, SELF_NOVA, vec![lethal(1)]),
            ko(1),
            ended(1, false, false),
            ended(11, true, true),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1 + 400,
            deadline_ms: t1 + 400 + PVE_MS,
        })
    );
    assert_eq!((out.unit_turns, out.actions), (3, 1));
    let me = unit_in(&b, 1);
    assert_eq!(
        (me.pos, me.state, me.guard),
        (c(3, 3), UnitState::Fainted, false)
    );
    assert_eq!(
        me.budget,
        TurnBudget {
            ap: 4,
            strides_used: 0,
            attacks: 1,
            last: Some(Entry::Attack(Tier::Light)),
        },
        "turn_end is skipped for a fainted actor"
    );
    assert_eq!(unit_in(&b, 2).budget, fresh());
}

/// BT3.4: a live Flee spends the full budget, hands the flee to the hook ONCE, and ends the
/// battle `Fled` by `EndHow::Fled` whatever the hook did (the fake leaves the outcome alone);
/// every READY row is voided.
/// Kills: Flee resolved without the hook; the outcome left to the hook; plans kept.
#[test]
fn a_live_flee_ends_the_battle_fled_whatever_the_hook_did_bt3_4() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(2, Side::A, 1, 1, 5, 35),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
        &w,
        &mut h,
    );
    submit(&mut b, T0 + 100, 2, vec![END], &w, &mut h);
    let out = submit(&mut b, T0 + 200, 1, vec![FLEE], &w, &mut h);
    assert_eq!(
        out.events,
        vec![battle_end(BattleOutcome::Fled, EndHow::Fled), voided(2)]
    );
    assert_eq!(
        h.resolve_calls,
        vec![(1, Validated::Flee { entry: Entry::Flee })]
    );
    assert_eq!(b.state.outcome, BattleOutcome::Fled);
    assert_eq!(
        (b.phase(), b.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert!(b.plans.is_empty() && b.state.queued.is_empty());
    assert_eq!(
        unit_in(&b, 1).budget,
        TurnBudget {
            ap: 0,
            strides_used: 0,
            attacks: 0,
            last: Some(Entry::Flee),
        }
    );
    assert_eq!(out.window, None);
}

/// BT3.4: `HaltReason::kind` is the stored coarse kind — Act → CannotAct, Path → Unreachable,
/// Geometry → Geometry, Economy → Unaffordable, BadUnit | Tuning → BadState, the rest one-to-one
/// — and `HaltKind` sits in its frozen order.
/// Kills: two reasons mapped onto one kind; BadUnit mapped to CannotAct.
#[test]
fn halt_reason_kind_is_the_stored_coarse_reason_bt3_4() {
    let cases = [
        (HaltReason::Act(ActError::Fainted(1)), HaltKind::CannotAct),
        (HaltReason::Act(ActError::BattleOver), HaltKind::CannotAct),
        (HaltReason::BadShape, HaltKind::BadShape),
        (
            HaltReason::UnknownSkill { skill_id: 3 },
            HaltKind::UnknownSkill,
        ),
        (HaltReason::TargetGone { id: 4 }, HaltKind::TargetGone),
        (
            HaltReason::Path(PathError::DestOccupied),
            HaltKind::Unreachable,
        ),
        (
            HaltReason::Path(PathError::Unreachable),
            HaltKind::Unreachable,
        ),
        (HaltReason::TooFar { cost: 3, points: 2 }, HaltKind::TooFar),
        (
            HaltReason::Geometry(GeometryError::NoTargetUnit),
            HaltKind::Geometry,
        ),
        (HaltReason::NotAdjacent { target: 5 }, HaltKind::NotAdjacent),
        (HaltReason::NotWild { target: 6 }, HaltKind::NotWild),
        (
            HaltReason::NotAllowed(ActionKind::Flee),
            HaltKind::NotAllowed,
        ),
        (HaltReason::NoHeadroom, HaltKind::NoHeadroom),
        (
            HaltReason::ItemNotHeld { item_id: POTION },
            HaltKind::ItemNotHeld,
        ),
        (
            HaltReason::Economy(EconomyError::ZeroStrides),
            HaltKind::Unaffordable,
        ),
        (
            HaltReason::BadUnit(DeployError::ZeroDefense { id: 1 }),
            HaltKind::BadState,
        ),
        (
            HaltReason::Tuning(TuningError::ZeroApTurn),
            HaltKind::BadState,
        ),
    ];
    for (reason, want) in cases {
        assert_eq!(reason.kind(), want, "{reason:?}");
    }
    let order = [
        HaltKind::CannotAct,
        HaltKind::BadShape,
        HaltKind::UnknownSkill,
        HaltKind::TargetGone,
        HaltKind::Unreachable,
        HaltKind::TooFar,
        HaltKind::Geometry,
        HaltKind::NotAdjacent,
        HaltKind::NotWild,
        HaltKind::NotAllowed,
        HaltKind::NoHeadroom,
        HaltKind::ItemNotHeld,
        HaltKind::Unaffordable,
        HaltKind::BadState,
    ];
    for (i, want) in order.iter().enumerate() {
        let i = u32::try_from(i).expect("small");
        assert_eq!(by_index::<HaltKind>(i).ok(), Some(*want), "HaltKind at {i}");
    }
    assert!(by_index::<HaltKind>(14).is_err());
}

/// BT3.4: control returns live only to a player-owned unit — every unit under the PvP ruleset
/// (Practice included), side A only in a wild battle — and only with at least the AP floor:
/// `min(light, stride, item)` = 2 at DESIGN, read from the tuning, never below 1.
/// Kills: Practice's side B treated as wild; a hard-coded floor of 2; a floor of 0.
#[test]
fn player_ownership_and_the_ap_floor_follow_the_ruleset_and_tuning_bt3_4() {
    assert!(is_player_owned(BattleKind::Wild, Side::A));
    assert!(!is_player_owned(BattleKind::Wild, Side::B));
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        assert!(is_player_owned(kind, Side::A), "{kind:?}");
        assert!(is_player_owned(kind, Side::B), "{kind:?}");
    }
    assert_eq!(min_action_cost(&design()), 2);
    assert_eq!(
        min_action_cost(&perturb(|t| {
            t.light_cost = 5;
            t.move_stride_cost = 4;
            t.item_cost = 3;
        })),
        3
    );
    assert_eq!(min_action_cost(&perturb(|t| t.move_stride_cost = 1)), 1);
    assert_eq!(
        min_action_cost(&perturb(|t| {
            t.light_cost = 0;
            t.move_stride_cost = 0;
            t.item_cost = 0;
        })),
        1,
        "never below 1"
    );
}

// ===========================================================================
// BT3.5 — TurnStart
// ===========================================================================

/// BT3.5: TurnStart resets the budget to `TurnBudget::fresh` (ap 6, strides 0, attacks 0, no
/// last action), turns Guard off and clears First-Stand — from a deliberately dirty unit.
/// Kills: a budget carried over; Guard surviving into the unit's own turn; First-Stand kept.
#[test]
fn turn_start_refreshes_the_budget_and_clears_guard_and_first_stand_bt3_5() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut dirty = mon(1, Side::A, 0, 1, 1, 40);
    dirty.guard = true;
    dirty.budget = TurnBudget {
        ap: 1,
        strides_used: 2,
        attacks: 3,
        last: Some(Entry::Item),
    };
    assert!(dirty.first_stand);
    let (b, _) = drive(
        BattleKind::Wild,
        vec![dirty, mon(11, Side::B, 0, 6, 6, 30)],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let me = unit_in(&b, 1);
    assert_eq!(
        me.budget,
        TurnBudget {
            ap: 6,
            strides_used: 0,
            attacks: 0,
            last: None,
        }
    );
    assert_eq!((me.guard, me.first_stand), (false, false));
}

/// BT3.5: fainted and recruited units in the frozen order are skipped silently — no event, no
/// `unit_turns`, no AI call, their rows untouched — and the round moves on.
/// Kills: TurnStart run on a corpse; a recruited wild asked to plan; skipped units counted.
#[test]
fn fainted_and_recruited_units_are_skipped_without_an_event_bt3_5() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 45),
        mon(11, Side::B, 0, 6, 1, 40),
        mon(12, Side::B, 1, 6, 6, 35),
        mon(2, Side::A, 1, 1, 6, 30),
    ]);
    assert_eq!(b.state.initiative, vec![1, 11, 12, 2]);
    {
        let u = b.state.unit_mut(1).expect("unit 1");
        u.state = UnitState::Fainted;
        u.cur_hp = 0;
        u.guard = true;
    }
    b.state.unit_mut(11).expect("unit 11").state = UnitState::Recruited;
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(out.events, vec![battle_started(1), ended(12, true, true)]);
    assert_eq!((out.unit_turns, out.actions), (2, 0));
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(h.plan_ai_log(), vec![12]);
    assert!(unit_in(&b, 1).guard, "a skipped unit is not touched");
    assert_eq!(unit_in(&b, 11).budget, TurnBudget::default());
}

/// Wild: 1 A (1,1) speed 40 carrying `status`, 2 A (1,5) speed 35 (waits), 11 B (6,6) speed 30;
/// optionally 1 pre-queued `[Move (1,3)]`.
fn skip_fixture(
    seed: u64,
    status: StatusEffect,
    queued: bool,
) -> (TacticalBattle, StepResult, FakeHooks) {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = battle_of(
        BattleKind::Wild,
        seed,
        vec![
            afflicted(mon(1, Side::A, 0, 1, 1, 40), status),
            mon(2, Side::A, 1, 1, 5, 35),
            mon(11, Side::B, 0, 6, 6, 30),
        ],
    );
    if queued {
        submit(&mut b, T0 - 100, 1, vec![mv(1, 3, 1)], &w, &mut h);
    }
    let out = start_at(&mut b, T0, &w, &mut h);
    (b, out, h)
}

/// BT3.5: a turn-skip status (Sleep) at TurnStart voids the READY row with a visible
/// `QueueVoided` and ends the turn UNCOMMITTED — `Status{Blocked}`, no Guard, no strike, no
/// window, nothing executed, no roll drawn — then the next unit starts.
/// Kills: the plan executed through Sleep; a blocked turn ending committed (free Guard) or
/// striking; a window opened for the blocked unit; a roll drawn for Sleep.
#[test]
fn a_turn_skip_status_voids_the_ready_row_and_ends_the_turn_uncommitted_bt3_5() {
    let sleep = StatusEffect::Sleep { turns_remaining: 3 };
    let (b, out, _) = skip_fixture(7, sleep, true);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            status_ev(1, sleep, StatusChange::Blocked, 0),
            voided(1),
            ended(1, false, false),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!((out.unit_turns, out.actions), (2, 0));
    assert_eq!(b.plan(1), None);
    assert!(b.state.queued.is_empty());
    let me = unit_in(&b, 1);
    assert_eq!((me.pos, me.guard), (c(1, 1), false));
    assert_eq!(me.budget, TurnBudget::default());
    assert_eq!(b.clocks[0].window_seq, 1, "only unit 2's window opened");
    assert_eq!(b.clocks[0].autopass_count, 0, "a blocked turn is no strike");
    assert_eq!(b.state.action_seq, 0, "Sleep draws nothing");
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_000,
            deadline_ms: T0 + 2_000 + PVE_MS,
        })
    );
}

/// BT3.5: a turn-skip status without a READY row emits `Status{Blocked}` and the uncommitted
/// `TurnEnded` — and NO `QueueVoided` (Freeze, which also draws nothing at TurnStart).
/// Kills: a QueueVoided for a plan that never existed; a thaw roll drawn at TurnStart.
#[test]
fn a_turn_skip_without_a_ready_row_emits_no_queue_voided_bt3_5() {
    let (b, out, _) = skip_fixture(7, StatusEffect::Freeze, false);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            status_ev(1, StatusEffect::Freeze, StatusChange::Blocked, 0),
            ended(1, false, false),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(b.state.action_seq, 0);
}

/// BT3.5: Paralysis draws exactly ONE roll, `splitmix64(seed ^ action_seq) % 100`, and blocks
/// below 25: a seed whose roll is 24 blocks the turn, one whose roll is 25 lets it run.
/// Kills: `<=` for `<`; Paralysis drawing no roll or two; the roll not taken from the stream.
#[test]
fn paralysis_blocks_on_a_roll_below_twenty_five_and_draws_once_bt3_5() {
    let seed_of = |roll: u64| {
        (0u64..)
            .find(|&s| mix(s) % 100 == roll)
            .expect("a seed with that first roll")
    };
    let (blocked, out, _) = skip_fixture(seed_of(24), StatusEffect::Paralysis, false);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            status_ev(1, StatusEffect::Paralysis, StatusChange::Blocked, 0),
            ended(1, false, false),
        ]
    );
    assert_eq!(blocked.turn_state, TurnState::Waiting(2));
    assert_eq!(blocked.state.action_seq, 1);

    let (acts, out, _) = skip_fixture(seed_of(25), StatusEffect::Paralysis, false);
    assert_eq!(out.events, vec![battle_started(1)]);
    assert_eq!(acts.turn_state, TurnState::Waiting(1));
    assert_eq!(acts.state.action_seq, 1, "exactly one draw");
}

/// The carried M14 rule: can side A's active monster act with `status` on `roll`?
fn carried_can_act(status: Option<StatusEffect>, roll: u8) -> bool {
    let mut store = BattleStatusStore::new(1, 0);
    store.side_a[0] = status;
    let battle = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };
    let variance = StatusVariance {
        action_skip_roll_a: roll,
        action_skip_roll_b: 0,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };
    apply_pre_turn_effects(&store, &battle, &variance).0
}

/// BT3.5: `status_blocks_turn` equals the carried `apply_pre_turn_effects` for every status and
/// every roll: Sleep and Freeze always block, Paralysis below 25, Poison / Burn / none never.
/// Kills: a re-stated rule that drifts from the carried one.
#[test]
fn status_blocks_turn_matches_the_carried_pre_turn_rule_bt3_5() {
    let statuses = [
        None,
        Some(StatusEffect::Poison),
        Some(StatusEffect::Burn),
        Some(StatusEffect::Paralysis),
        Some(StatusEffect::Sleep { turns_remaining: 1 }),
        Some(StatusEffect::Sleep { turns_remaining: 3 }),
        Some(StatusEffect::Freeze),
    ];
    for status in statuses {
        for roll in 0..=u8::MAX {
            assert_eq!(
                status_blocks_turn(status, roll),
                !carried_can_act(status, roll),
                "{status:?} on {roll}"
            );
        }
    }
    assert!(status_blocks_turn(Some(StatusEffect::Paralysis), 24));
    assert!(!status_blocks_turn(Some(StatusEffect::Paralysis), 25));
    assert!(status_blocks_turn(Some(StatusEffect::Freeze), 99));
    assert!(!status_blocks_turn(Some(StatusEffect::Poison), 0));
}

/// Wild: 11 B (5,3) speed 40 plans `[Move (3,3), Light → 1, EndTurn]`; 1 A (2,3) speed 30.
fn ai_first() -> (TacticalBattle, StepResult, FakeHooks) {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![mv(3, 3, 1), sk(LIGHT, 1), END]);
    let (b, out) = drive(
        BattleKind::Wild,
        vec![mon(11, Side::B, 0, 5, 3, 40), mon(1, Side::A, 0, 2, 3, 30)],
        &w,
        &mut h,
    );
    (b, out, h)
}

/// BT3.5: a wild's TurnStart executes `ai::plan` (the hook, asked once, for that unit) with
/// origin AI: its `[Move, Light, EndTurn]` resolves Moved → Executed → TurnEnded, then the
/// player's unit waits.
/// Kills: the AI never asked; asked twice; the wild entering `Waiting`.
#[test]
fn a_wild_executes_its_ai_plan_at_turn_start_bt3_5() {
    let (b, out, h) = ai_first();
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            moved(11, (5, 3), (3, 3), 2),
            executed(11, LIGHT, vec![chip(1)]),
            ended(11, false, true),
        ]
    );
    assert_eq!(h.plan_ai_log(), vec![11]);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(unit_in(&b, 11).pos, c(3, 3));
    assert_eq!(unit_in(&b, 1).cur_hp, 99);
    assert_eq!((out.unit_turns, out.actions), (2, 2));
}

/// BT3.5: a player unit's READY row is consumed at TurnStart (row and `queued` entry gone) and
/// executed with origin PreQueued (its drain ends the turn committed); a unit with no row waits,
/// with the window open and the turn-order cursor on it.
/// Kills: the row kept after execution; a queued unit asked to wait; `turn_idx` off by one.
#[test]
fn a_ready_row_is_consumed_at_turn_start_and_a_unit_without_one_waits_bt3_5() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(11, Side::B, 0, 7, 7, 35),
        mon(2, Side::A, 1, 4, 1, 30),
    ]);
    submit(&mut b, T0 - 100, 1, vec![mv(1, 3, 1)], &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            moved(1, (1, 1), (1, 3), 2),
            ended(1, true, true),
            ended(11, true, true),
        ]
    );
    assert_eq!(b.plan(1), None);
    assert!(b.state.queued.is_empty());
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(b.turn_idx(), 2);
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_200,
            deadline_ms: T0 + 2_200 + PVE_MS,
        })
    );
}

/// BT3.5: each unit-turn starts its own window count — unit 1 used 2 windows, unit 2's TurnStart
/// restarts the count at 1 on the shared side clock (the seq keeps counting).
/// Kills: the window count carried across unit-turns (the next unit would hit the cap early).
#[test]
fn a_new_unit_turn_restarts_the_window_count_bt3_5() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 1, 1, 40),
            mon(2, Side::A, 1, 1, 6, 35),
            mon(11, Side::B, 0, 7, 7, 30),
        ],
        &w,
        &mut h,
    );
    submit(&mut b, T0 + 3_000, 1, vec![mv(1, 3, 1)], &w, &mut h);
    assert_eq!(b.clocks[0].windows_this_unit_turn, 2);
    let t2 = T0 + 4_000;
    let out = submit(&mut b, t2, 1, vec![END], &w, &mut h);
    assert_eq!(out.events, vec![ended(1, true, true)]);
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 3,
            opens_at_ms: t2,
            deadline_ms: t2 + PVE_MS,
        })
    );
    assert_eq!(b.clocks[0].windows_this_unit_turn, 1);
}

// ===========================================================================
// BT3.6 — the chain rule
// ===========================================================================

/// Wild, both player units pre-queued, both wilds scripted, 12 Poisoned (ticks 12 in upkeep):
///
/// ```text
///   1 A (1,1) speed 48  queued [Move (3,1)]          11 B (6,1) speed 46  AI [Move (5,1), EndTurn]
///   2 A (1,4) speed 44  queued [Move (2,4)]          12 B (6,4) speed 42  AI [EndTurn], Poison
/// ```
fn chain4(w: &World) -> (TacticalBattle, StepResult, FakeHooks) {
    let mut h = FakeHooks::new()
        .ai_plan(11, vec![mv(5, 1, 1), END])
        .ai_plan(12, vec![END]);
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 48),
        mon(11, Side::B, 0, 6, 1, 46),
        mon(2, Side::A, 1, 1, 4, 44),
        afflicted(mon(12, Side::B, 1, 6, 4, 42), StatusEffect::Poison),
    ]);
    submit(&mut b, T0 - 100, 1, vec![mv(3, 1, 1)], w, &mut h);
    submit(&mut b, T0 - 100, 2, vec![mv(2, 4, 1)], w, &mut h);
    let out = start_at(&mut b, T0, w, &mut h);
    (b, out, h)
}

/// BT3.6: one `start` chains every pre-queued and AI turn of the round, runs the round's upkeep
/// (`RoundEnded{1}` BEFORE the upkeep's events) and stops at the boundary: `Advancing`, pinned
/// `(battle_id, 2)`, the step's round 1, 4 unit-turns, 3 actions.
/// Kills: stopping before upkeep; continuing into round 2; RoundEnded after the ticks; the step
/// stamped with the new round.
#[test]
fn one_step_chains_the_round_through_upkeep_and_stops_at_the_boundary_bt3_6() {
    let w = World::new();
    let (b, out, _) = chain4(&w);
    assert_eq!(
        out,
        StepResult {
            events: vec![
                battle_started(1),
                moved(1, (1, 1), (3, 1), 2),
                ended(1, true, true),
                moved(11, (6, 1), (5, 1), 1),
                ended(11, true, true),
                moved(2, (1, 4), (2, 4), 1),
                ended(2, true, true),
                ended(12, true, true),
                round_ended(1),
                status_ev(12, StatusEffect::Poison, StatusChange::Tick, 12),
            ],
            round: 1,
            window: None,
            unit_turns: 4,
            actions: 3,
        }
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(
        b.advance_pin(),
        Some(AdvancePin {
            battle_id: BID,
            round: 2
        })
    );
    assert_eq!(b.state.round, 2);
    assert!(b.plans.is_empty() && b.state.queued.is_empty());
    assert_eq!(unit_in(&b, 12).cur_hp, 88);
}

/// BT3.6: `advance` runs the next round only from `Advancing` with the CURRENT pin — a stale
/// round or another battle's id is `StaleAdvance{current}` and changes nothing; the right pin
/// starts round 2 (its step stamped round 2); a second fire, or `start`, is `NotStartable`.
/// Kills: a duplicate/stale fire re-running the round; the pin unchecked.
#[test]
fn advance_runs_the_next_round_only_with_the_current_pin_bt3_6() {
    let w = World::new();
    let (mut b, _, mut h) = chain4(&w);
    let current = AdvancePin {
        battle_id: BID,
        round: 2,
    };
    let t1 = T0 + 60_000;
    for stale in [
        AdvancePin {
            battle_id: BID,
            round: 3,
        },
        AdvancePin {
            battle_id: BID,
            round: 1,
        },
        AdvancePin {
            battle_id: BID + 1,
            round: 2,
        },
    ] {
        let before = b.clone();
        assert_eq!(
            b.advance(t1, stale, &w.rules(), &mut h),
            Err(StepError::StaleAdvance { current }),
            "{stale:?}"
        );
        assert_eq!(b, before);
    }
    let out = b
        .advance(t1, current, &w.rules(), &mut h)
        .expect("the pinned fire");
    assert_eq!(out.round, 2);
    assert_eq!(out.events, vec![]);
    assert_eq!((out.unit_turns, out.actions), (1, 0));
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(b.advance_pin(), None);

    let before = b.clone();
    assert_eq!(
        b.advance(t1, current, &w.rules(), &mut h),
        Err(StepError::NotStartable {
            turn_state: TurnState::Waiting(1)
        })
    );
    assert_eq!(
        b.start(t1, &w.rules(), &mut h),
        Err(StepError::NotStartable {
            turn_state: TurnState::Waiting(1)
        })
    );
    assert_eq!(b, before);
}

/// BT3.6: `start` runs only from `NotActive` on an `Ongoing` battle and validates the tuning
/// first; `advance` refuses a battle that is not `Advancing`. Every refusal changes nothing.
/// Kills: a second start re-running round 1; a finished battle restarted; the tuning unchecked.
#[test]
fn start_runs_only_from_not_active_on_an_ongoing_battle_bt3_6() {
    let w = World::new();
    let bad = World::tuned(perturb(|t| t.guard_den = 0));
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(11, Side::B, 0, 6, 6, 30),
    ]);
    let fresh_battle = b.clone();
    assert_eq!(
        b.start(T0, &bad.rules(), &mut h),
        Err(StepError::Tuning(TuningError::ZeroGuardDen))
    );
    assert_eq!(
        b.advance(
            T0,
            AdvancePin {
                battle_id: BID,
                round: 1
            },
            &w.rules(),
            &mut h
        ),
        Err(StepError::NotStartable {
            turn_state: TurnState::NotActive
        })
    );
    assert_eq!(b, fresh_battle);
    start_at(&mut b, T0, &w, &mut h);
    b.conclude(BattleOutcome::SideBWins, EndHow::Forfeit)
        .expect("ends");
    let finished = b.clone();
    assert_eq!(
        b.start(T0 + 1, &w.rules(), &mut h),
        Err(StepError::NotStartable {
            turn_state: TurnState::NotActive
        }),
        "NotActive but decided"
    );
    assert_eq!(b, finished);
}

/// The 3v3 worst case: every unit plans 3 actions (Move, Move, NOVA = 6 AP), the A side
/// pre-queued, the B side scripted; columns 0–2 against 5–7 keep everyone out of reach (no tax,
/// NOVA hits nobody).
fn worst_case(w: &World) -> (TacticalBattle, StepResult, FakeHooks) {
    let lanes: [(u32, Side, u8, u8, u16); 6] = [
        (1, Side::A, 0, 0, 49),
        (11, Side::B, 0, 5, 48),
        (2, Side::A, 1, 1, 47),
        (12, Side::B, 1, 6, 46),
        (3, Side::A, 2, 2, 45),
        (13, Side::B, 2, 7, 44),
    ];
    let mut h = FakeHooks::new();
    let mut units = Vec::new();
    for (id, side, slot, x, speed) in lanes {
        let y = if side == Side::A { 0 } else { 7 };
        units.push(mon(id, side, slot, x, y, speed));
        if side == Side::B {
            h = h.ai_plan(id, vec![mv(x, 5, 1), mv(x, 3, 1), sk_self(NOVA)]);
        }
    }
    let mut b = wild(units);
    for (id, side, _, x, _) in lanes {
        if side == Side::A {
            submit(
                &mut b,
                T0 - 100,
                id,
                vec![mv(x, 2, 1), mv(x, 4, 1), sk_self(NOVA)],
                w,
                &mut h,
            );
        }
    }
    let out = start_at(&mut b, T0, w, &mut h);
    (b, out, h)
}

/// BT3.6: the worst-case step is bounded: exactly 6 unit-turns × 3 actions = 18 actions and one
/// upkeep (one `RoundEnded`), and no unit of round 2 starts (every budget is idle).
/// Kills: a chain that crosses into round 2; actions miscounted (EndTurn counted, or attacks
/// not counted).
#[test]
fn the_worst_case_step_is_six_unit_turns_of_three_actions_and_one_upkeep_bt3_6() {
    let w = World::new();
    let (b, out, _) = worst_case(&w);
    let mut want = vec![battle_started(1)];
    for (id, x, ys) in [
        (1u32, 0u8, [0u8, 2, 4]),
        (11, 5, [7, 5, 3]),
        (2, 1, [0, 2, 4]),
        (12, 6, [7, 5, 3]),
        (3, 2, [0, 2, 4]),
        (13, 7, [7, 5, 3]),
    ] {
        want.push(moved(id, (x, ys[0]), (x, ys[1]), 2));
        want.push(moved(id, (x, ys[1]), (x, ys[2]), 2));
        want.push(executed(id, NOVA, vec![]));
        want.push(ended(id, false, true));
    }
    want.push(round_ended(1));
    assert_eq!(out.events, want);
    assert_eq!((out.unit_turns, out.actions), (6, 18));
    assert_eq!(
        count(&out.events, |e| matches!(e, EventPayload::RoundEnded(_))),
        1
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(b.state.round, 2);
    for u in &b.state.units {
        assert_eq!(
            u.budget,
            TurnBudget::default(),
            "unit {} did not start round 2",
            u.id
        );
    }
}

/// BT3.6: the chain walks a SNAPSHOT of the initiative: 2's live attack KOs 11, which acted
/// earlier this round, and 12 — after 2 — still gets its TurnStart.
/// Kills: the cursor kept as an index into the live (shrunk) initiative, skipping 12.
#[test]
fn a_ko_of_an_earlier_unit_does_not_shift_the_turn_cursor_bt3_6() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 0, 0, 50),
        with_hp(mon(11, Side::B, 0, 4, 3, 45), 1),
        mon(2, Side::A, 1, 3, 3, 40),
        mon(12, Side::B, 1, 7, 7, 30),
    ]);
    submit(&mut b, T0 - 100, 1, vec![END], &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            ended(1, true, true),
            ended(11, true, true)
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    let out = submit(&mut b, T0 + 5_000, 2, vec![sk(LIGHT, 11), END], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            executed(
                2,
                LIGHT,
                vec![TargetHit {
                    guard: true,
                    ..lethal(11)
                }]
            ),
            ko(11),
            ended(2, false, true),
            ended(12, true, true),
            round_ended(1),
        ],
        "11 ended its turn with Guard, which still floors the chip at 1"
    );
    assert_eq!(h.plan_ai_log(), vec![11, 12]);
    assert_eq!((out.unit_turns, out.actions), (2, 1));
    assert_eq!(b.turn_state, TurnState::Advancing);
}

/// BT3.6: a unit KO'd before its turn (by an earlier unit in the same step) is skipped — no
/// TurnStart, no AI call, no event.
/// Kills: a KO'd unit taking its turn; a dead wild asked to plan.
#[test]
fn a_unit_kod_before_its_turn_is_skipped_bt3_6() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 3, 3, 45),
        mon(11, Side::B, 0, 7, 0, 40),
        exposed(with_hp(mon(12, Side::B, 1, 4, 3, 35), 1)),
        mon(2, Side::A, 1, 0, 7, 30),
    ]);
    submit(&mut b, T0 - 100, 1, vec![sk(LIGHT, 12)], &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            executed(1, LIGHT, vec![lethal(12)]),
            ko(12),
            ended(1, false, true),
            ended(11, true, true),
        ]
    );
    assert_eq!(h.plan_ai_log(), vec![11]);
    assert_eq!((out.unit_turns, out.actions), (3, 1));
    assert_eq!(b.turn_state, TurnState::Waiting(2));
}

/// BT3.6: after a live self-KO the round continues with exactly the rest of the snapshot —
/// 11, then 12, then 2 waits — each started once.
/// Kills: the self-KO'd unit restarted; a unit started twice; the round stalled.
#[test]
fn a_live_self_ko_starts_each_remaining_unit_exactly_once_bt3_6() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            with_hp(mon(1, Side::A, 0, 3, 3, 45), 1),
            mon(11, Side::B, 0, 7, 0, 40),
            mon(12, Side::B, 1, 7, 7, 35),
            mon(2, Side::A, 1, 0, 7, 30),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let out = submit(&mut b, T0 + 2_500, 1, vec![sk_self(SELF_NOVA)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            executed(1, SELF_NOVA, vec![lethal(1)]),
            ko(1),
            ended(1, false, false),
            ended(11, true, true),
            ended(12, true, true),
        ]
    );
    assert_eq!(h.plan_ai_log(), vec![11, 12]);
    assert_eq!(out.unit_turns, 4);
    assert_eq!(b.turn_state, TurnState::Waiting(2));
}

/// BT3.6: a battle won mid-round (the last wild KO'd) finishes there: `BattleEnd`, every READY
/// row voided, `NotActive`, `Finished`, no upkeep (the round unchanged), no window.
/// Kills: the chain continuing past the end; upkeep run on a finished battle.
#[test]
fn a_battle_won_mid_round_finishes_without_upkeep_bt3_6() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 3, 3, 40),
            exposed(with_hp(mon(11, Side::B, 0, 4, 3, 30), 1)),
            mon(2, Side::A, 1, 0, 7, 20),
            mon(3, Side::A, 2, 0, 5, 10),
        ],
        &w,
        &mut h,
    );
    submit(&mut b, T0 + 100, 3, vec![END], &w, &mut h);
    submit(&mut b, T0 + 100, 2, vec![END], &w, &mut h);
    let out = submit(&mut b, T0 + 3_000, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out,
        StepResult {
            events: vec![
                executed(1, LIGHT, vec![lethal(11)]),
                ko(11),
                battle_end(BattleOutcome::SideAWins, EndHow::SideEmpty),
                voided(2),
                voided(3),
            ],
            round: 1,
            window: None,
            unit_turns: 1,
            actions: 1,
        }
    );
    assert_eq!(
        (b.turn_state, b.phase()),
        (TurnState::NotActive, Phase::Finished)
    );
    assert_eq!(b.state.round, 1, "no upkeep ran");
    assert_eq!(b.state.outcome, BattleOutcome::SideAWins);
    assert!(b.plans.is_empty() && b.state.queued.is_empty());
    assert_eq!(
        (b.clocks[0].window_open_ms, b.clocks[0].deadline_ms),
        (None, None)
    );
}

/// BT3.6: an Item whose (hook-resolved) effect KOs both last units of a PvP battle is
/// adjudicated on the snapshot taken BEFORE the entry: B held 80 % to A's 30 %, so B wins on HP
/// percent. (The seed is chosen so the coin a post-entry snapshot would fall back to says A.)
/// Kills: the snapshot captured after the delegated resolution.
#[test]
fn an_item_double_ko_is_adjudicated_on_the_pre_entry_snapshot_bt3_6() {
    let w = World::new();
    let seed = (0u64..)
        .find(|&s| mix(s ^ 1) & 1 == 0)
        .expect("a seed whose round-1 coin is A");
    let mut h = FakeHooks::new().holding(POTION, 1);
    h.item_fx = ItemFx::Wipe;
    let mut b = battle_of(
        BattleKind::Pvp,
        seed,
        vec![
            with_hp(mon(1, Side::A, 0, 1, 1, 40), 30),
            with_hp(mon(11, Side::B, 0, 6, 6, 30), 80),
        ],
    );
    start_at(&mut b, T0, &w, &mut h);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let out = submit(
        &mut b,
        T0 + 3_000,
        1,
        vec![use_item(POTION, ActionTarget::SelfTarget)],
        &w,
        &mut h,
    );
    assert_eq!(
        out.events,
        vec![
            item_used(1, POTION, 1),
            ko(1),
            ko(11),
            battle_end(BattleOutcome::SideBWins, EndHow::AdjudicatedHpPercent),
        ]
    );
    assert_eq!(b.state.outcome, BattleOutcome::SideBWins);
    assert_eq!(b.phase(), Phase::Finished);
}

/// BT3.6: a recruit removal mid-step (the hook removes 11 from the order) leaves the snapshot
/// cursor intact: the recruited 11 is skipped silently and 12 still takes its turn.
/// Kills: the recruited unit started; the cursor shifted by the removal.
#[test]
fn a_recruit_removal_mid_step_leaves_the_snapshot_cursor_intact_bt3_6() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            mon(1, Side::A, 0, 3, 3, 40),
            mon(11, Side::B, 0, 4, 3, 30),
            mon(12, Side::B, 1, 7, 7, 20),
        ],
        &w,
        &mut h,
    );
    let out = submit(&mut b, T0 + 2_500, 1, vec![recruit(11, None)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            EventPayload::RecruitResult(RecruitResultEvent {
                unit: 1,
                target: 11,
                success: true,
                pct: 50,
            }),
            ended(1, false, true),
            ended(12, true, true),
            round_ended(1),
        ]
    );
    assert_eq!(
        h.resolve_calls,
        vec![(
            1,
            Validated::Recruit {
                target: 11,
                bait: None,
                entry: Entry::Recruit,
            }
        )]
    );
    assert_eq!(h.plan_ai_log(), vec![12]);
    assert_eq!((out.unit_turns, out.actions), (2, 1));
    assert_eq!(unit_in(&b, 11).state, UnitState::Recruited);
    assert_eq!(b.turn_state, TurnState::Advancing);
}

/// BT3.6: a new battle is `NotActive` with no plans, idle clocks, no pad and `queued` cleared
/// (a stale mirror is dropped); nothing waits and no boundary is pinned.
/// Kills: a constructor that keeps the shell's `queued` mirror or starts the round.
#[test]
fn a_new_battle_is_not_active_with_no_plans_and_idle_clocks_bt3_6() {
    let mut st = state_on(
        BattleKind::Wild,
        7,
        &[],
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 6, 6, 30)],
    );
    st.queued = vec![1, 11];
    let b = TacticalBattle::new(BID, st);
    assert_eq!(b.battle_id, BID);
    assert!(b.plans.is_empty());
    assert!(b.state.queued.is_empty());
    assert_eq!(b.turn_state, TurnState::NotActive);
    assert_eq!(b.clocks, [ClockState::default(); 2]);
    assert_eq!(b.pending_pad_ms, 0);
    assert_eq!(b.phase(), Phase::Active);
    assert_eq!((b.turn_idx(), b.advance_pin(), b.plan(1)), (0, None, None));
}

// ===========================================================================
// BT3.7 — READY rows
// ===========================================================================

fn voided_count(events: &[EventPayload]) -> usize {
    count(events, |e| matches!(e, EventPayload::QueueVoided(_)))
}

/// Wild: 11 B (4,3) speed 45 plans `[Light → 2, EndTurn]`; 1 A (0,7) speed 40 waits; 2 A (3,3)
/// speed 30, 1 HP, First-Stand spent, holds the READY row `[Move (3,5)]`.
fn doomed_row() -> (TacticalBattle, FakeHooks) {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![sk(LIGHT, 2), END]);
    let mut b = wild(vec![
        mon(11, Side::B, 0, 4, 3, 45),
        mon(1, Side::A, 0, 0, 7, 40),
        exposed(with_hp(mon(2, Side::A, 1, 3, 3, 30), 1)),
    ]);
    submit(&mut b, T0 - 100, 2, vec![mv(3, 5, 1)], &w, &mut h);
    (b, h)
}

/// BT3.7: a queued unit KO'd by an attack loses its READY row with exactly ONE visible
/// `QueueVoided` (the sweep's), and `queued` follows.
/// Kills: the row kept (the corpse's plan would pop); a second QueueVoided from the re-sync.
#[test]
fn a_queued_unit_kod_by_an_attack_loses_its_row_with_one_event_bt3_7() {
    let w = World::new();
    let (mut b, mut h) = doomed_row();
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            executed(11, LIGHT, vec![lethal(2)]),
            ko(2),
            voided(2),
            ended(11, false, true),
        ]
    );
    assert_eq!(voided_count(&out.events), 1);
    assert_eq!(b.plan(2), None);
    assert!(b.state.queued.is_empty());
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

/// BT3.7: `plans` is the authority — a stale `queued` mirror (missing 2, inventing 1) is
/// re-derived at the input, so 2's KO still voids its row visibly, once, and no phantom id
/// survives.
/// Kills: trusting the shell-loaded mirror (the row silently dropped, or a phantom kept).
#[test]
fn a_stale_queued_mirror_never_hides_or_invents_a_row_bt3_7() {
    let w = World::new();
    let (mut b, mut h) = doomed_row();
    b.state.queued = vec![1];
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(voided_count(&out.events), 1);
    assert!(out.events.contains(&voided(2)));
    assert_eq!(b.plan(2), None);
    assert!(b.state.queued.is_empty(), "{:?}", b.state.queued);
}

/// Wild: 2 A (1,1) speed 45 (`max_hp`, `hp`, `status`), 1 A (1,5) speed 40, 11 B (7,7) speed 30.
/// 2 acts first (`[EndTurn]` live), THEN pre-queues `[Move (1,3)]` — a row for its NEXT turn —
/// and 1 ends the round live.
fn next_turn_row(
    max_hp: u16,
    hp: u16,
    status: Option<StatusEffect>,
) -> (TacticalBattle, StepResult, StepResult, FakeHooks) {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut two = unit(
        2,
        Side::A,
        1,
        c(1, 1),
        water(max_hp, CHIP_DEF, 45, kit_skills()),
        hp,
    );
    two.status = status;
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![
            two,
            mon(1, Side::A, 0, 1, 5, 40),
            mon(11, Side::B, 0, 7, 7, 30),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    submit(&mut b, T0 + 1_000, 2, vec![END], &w, &mut h);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let queued = submit(&mut b, T0 + 1_500, 2, vec![mv(1, 3, 1)], &w, &mut h);
    let out = submit(&mut b, T0 + 2_000, 1, vec![END], &w, &mut h);
    (b, queued, out, h)
}

/// BT3.7: a queued unit KO'd by an upkeep Poison tick loses its row with exactly one
/// `QueueVoided`, after its `Ko`, inside the upkeep batch.
/// Kills: the row surviving a tick KO; a duplicate QueueVoided.
#[test]
fn a_queued_unit_kod_by_an_upkeep_tick_loses_its_row_with_one_event_bt3_7() {
    let (b, _, out, _) = next_turn_row(16, 2, Some(StatusEffect::Poison));
    assert_eq!(
        out.events,
        vec![
            ended(1, true, true),
            ended(11, true, true),
            round_ended(1),
            status_ev(2, StatusEffect::Poison, StatusChange::Tick, 2),
            ko(2),
            voided(2),
        ]
    );
    assert_eq!(voided_count(&out.events), 1);
    assert_eq!(b.plan(2), None);
    assert!(b.state.queued.is_empty());
    assert_eq!(b.turn_state, TurnState::Advancing);
}

/// BT3.7: a READY row survives the round boundary — it is the unit's NEXT turn, whenever that
/// is: still stored while `Advancing`, executed at the unit's round-2 TurnStart.
/// Kills: rows cleared at upkeep / round start; a row for a unit that already acted refused.
#[test]
fn a_ready_row_survives_the_round_boundary_bt3_7() {
    let w = World::new();
    let (mut b, queued, out, mut h) = next_turn_row(100, 100, None);
    assert_eq!(queued, quiet(1));
    assert_eq!(
        out.events,
        vec![ended(1, true, true), ended(11, true, true), round_ended(1)]
    );
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(
        b.plan(2),
        Some(&ReadyPlan {
            unit: 2,
            entries: vec![mv(1, 3, 1), END],
        })
    );
    assert_eq!(b.state.queued, vec![2]);
    let pin = b.advance_pin().expect("pinned");
    let out = b
        .advance(T0 + 2_100, pin, &w.rules(), &mut h)
        .expect("round 2");
    assert_eq!(out.round, 2);
    assert_eq!(
        out.events,
        vec![moved(2, (1, 1), (1, 3), 2), ended(2, true, true)]
    );
    assert_eq!(b.plan(2), None);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

/// BT3.7: the battle's end voids every remaining READY row — `QueueVoided` each, ascending unit,
/// after `BattleEnd` — and `queued` is cleared.
/// Kills: rows left behind a finished battle; voided in submit order.
#[test]
fn the_battle_end_voids_every_remaining_row_in_ascending_order_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    submit(&mut b, T0, 3, vec![END], &w, &mut h);
    submit(&mut b, T0, 2, vec![mv(2, 6, 1)], &w, &mut h);
    let out = b
        .conclude(BattleOutcome::SideBWins, EndHow::Forfeit)
        .expect("ends");
    assert_eq!(
        out.events,
        vec![
            battle_end(BattleOutcome::SideBWins, EndHow::Forfeit),
            voided(2),
            voided(3),
        ]
    );
    assert!(b.plans.is_empty() && b.state.queued.is_empty());
}

/// BT3.7: a cancel arriving after TurnStart is `AlreadyActing` — for the waiting unit whose row
/// was consumed (its plan halted and returned control) and for a unit that acted earlier this
/// round — and changes nothing.
/// Kills: `NoPlan` for a consumed row; a cancel after TurnStart accepted.
#[test]
fn a_cancel_after_turn_start_is_already_acting_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new().ai_plan(11, vec![mv(6, 3, 1), END]);
    let mut b = wild(vec![
        mon(11, Side::B, 0, 4, 3, 45),
        mon(1, Side::A, 0, 3, 3, 40),
    ]);
    submit(&mut b, T0 - 100, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        b.turn_state,
        TurnState::Waiting(1),
        "the queued Light halted"
    );
    let before = b.clone();
    assert_eq!(b.cancel_queue(Side::A, 1), Err(CancelError::AlreadyActing));
    assert_eq!(b, before);

    let mut h = FakeHooks::new();
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(11, Side::B, 0, 7, 7, 35),
        mon(2, Side::A, 1, 4, 1, 30),
    ]);
    submit(&mut b, T0 - 100, 1, vec![mv(1, 3, 1)], &w, &mut h);
    start_at(&mut b, T0, &w, &mut h);
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    let before = b.clone();
    assert_eq!(b.cancel_queue(Side::A, 1), Err(CancelError::AlreadyActing));
    assert_eq!(b.cancel_queue(Side::A, 2), Err(CancelError::AlreadyActing));
    assert_eq!(b, before);
}

/// BT3.7: a cancel for a later unit with no row is `NoPlan`; a cancel from the other side is
/// `NotYourUnit` (checked first); each changes nothing.
/// Kills: AlreadyActing for a unit that has not started; another side cancelling a plan.
#[test]
fn a_cancel_without_a_row_or_from_the_other_side_is_refused_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    submit(&mut b, T0, 3, vec![END], &w, &mut h);
    let before = b.clone();
    assert_eq!(b.cancel_queue(Side::A, 2), Err(CancelError::NoPlan));
    assert_eq!(b.cancel_queue(Side::B, 3), Err(CancelError::NotYourUnit));
    assert_eq!(b.cancel_queue(Side::B, 2), Err(CancelError::NotYourUnit));
    assert_eq!(b.cancel_queue(Side::A, 11), Err(CancelError::NotYourUnit));
    assert_eq!(b, before);
    assert!(b.plan(3).is_some());
}

/// BT3.7: cancelling a READY row deletes exactly that row (and its `queued` entry) — the battle
/// is otherwise byte-identical to before the pre-queue.
/// Kills: a cancel that also touches the clock or another row.
#[test]
fn cancelling_a_ready_row_deletes_only_that_row_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    submit(&mut b, T0, 3, vec![END], &w, &mut h);
    let before = b.clone();
    submit(&mut b, T0 + 10, 2, vec![mv(2, 6, 1)], &w, &mut h);
    assert_eq!(b.cancel_queue(Side::A, 2), Ok(()));
    assert_eq!(b, before);
    assert_eq!(b.plan(2), None);
    assert_eq!(b.state.queued, vec![3]);
}

/// BT3.7: the same consumable in two READY plans (one potion in the shared bag): the first to
/// pop uses it (`ItemUsed`, one debit), the second halts at that entry (`PlanHalted{idx 0,
/// ItemNotHeld}`, 0 AP, no `ItemUsed`) and gets its turn back live.
/// Kills: a server-side double spend; the inventory read at submit only; AP charged.
#[test]
fn the_second_plan_to_pop_a_shared_consumable_halts_at_that_entry_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(POTION, 1);
    let mut b = wild(vec![
        with_hp(mon(1, Side::A, 0, 1, 1, 40), 50),
        with_hp(mon(2, Side::A, 1, 1, 5, 35), 50),
        mon(11, Side::B, 0, 7, 7, 30),
    ]);
    let potion = vec![use_item(POTION, ActionTarget::SelfTarget)];
    submit(&mut b, T0 - 100, 1, potion.clone(), &w, &mut h);
    submit(&mut b, T0 - 100, 2, potion, &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            battle_started(1),
            item_used(1, POTION, 1),
            ended(1, true, true),
            halted(2, 0, HaltKind::ItemNotHeld),
        ]
    );
    assert_eq!(h.take_calls, vec![(1, POTION)]);
    assert_eq!(b.turn_state, TurnState::Waiting(2));
    assert_eq!(unit_in(&b, 2).budget, fresh());
    assert_eq!((unit_in(&b, 1).cur_hp, unit_in(&b, 2).cur_hp), (70, 50));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_400,
            deadline_ms: T0 + 2_400 + PVE_MS,
        })
    );
}

/// BT3.7: a debit that fails at execution (`take_item` → false) halts the entry with
/// `ItemNotHeld` and spends nothing — for a Recruit's bait and for an Item — and the delegated
/// resolver is never reached.
/// Kills: the bait debit's bool unchecked (a free bait); AP spent before the debit.
#[test]
fn a_failed_debit_halts_the_entry_with_nothing_spent_bt3_7() {
    let w = World::new();
    let mut h = FakeHooks::new().holding(BAIT, 1).holding(POTION, 1);
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    h.take_fails = true;
    let t1 = T0 + 5_000;
    let out = submit(&mut b, t1, 1, vec![recruit(11, Some(BAIT))], &w, &mut h);
    assert_eq!(out.events, vec![halted(1, 0, HaltKind::ItemNotHeld)]);
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1,
            deadline_ms: t1 + PVE_MS,
        })
    );
    assert_eq!(h.take_calls, vec![(1, BAIT)]);
    assert!(h.resolve_calls.is_empty());
    assert_eq!(unit_in(&b, 1).budget, fresh());
    assert_eq!(unit_in(&b, 11).state, UnitState::Active);

    let t2 = t1 + 1_000;
    let out = submit(
        &mut b,
        t2,
        1,
        vec![use_item(POTION, ActionTarget::SelfTarget)],
        &w,
        &mut h,
    );
    assert_eq!(out.events, vec![halted(1, 0, HaltKind::ItemNotHeld)]);
    assert!(h.resolve_calls.is_empty());
    assert_eq!(unit_in(&b, 1).budget, fresh());
    assert_eq!(b.turn_state, TurnState::Waiting(1));
}

// ===========================================================================
// BT3.8 — InvalidNow
// ===========================================================================

/// PvP 1v1 started at T0, waiting on 1: 1 A (1,1) speed 40, 11 B (6,6) speed 30; window 1 is
/// [T0 + 2 000, T0 + 32 000].
fn pvp_duel(w: &World, h: &mut FakeHooks) -> TacticalBattle {
    let mut b = pvp_battle(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(11, Side::B, 0, 6, 6, 30),
    ]);
    let out = start_at(&mut b, T0, w, h);
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_000,
            deadline_ms: T0 + 2_000 + PVP_MS,
        })
    );
    b
}

/// BT3.8: a live submit whose FIRST entry fails the execution gate now is
/// `InvalidNow{reason}` — a target out of reach, a destination occupied — nothing executes and
/// the window keeps running (same seq, same deadline), so the original deadline still fires.
/// Kills: executing anything on InvalidNow; closing, resetting or reopening the window.
#[test]
fn a_live_submit_whose_first_entry_fails_now_is_invalid_now_bt3_8() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = pvp_duel(&w, &mut h);
    assert_eq!(
        refused(
            &mut b,
            T0 + 5_000,
            Side::A,
            1,
            vec![sk(LIGHT, 11)],
            &w,
            &mut h
        ),
        SubmitError::InvalidNow {
            reason: HaltReason::Geometry(GeometryError::OutOfRange { distance: 10 })
        }
    );
    assert_eq!(
        refused(
            &mut b,
            T0 + 6_000,
            Side::A,
            1,
            vec![mv(6, 6, 2)],
            &w,
            &mut h
        ),
        SubmitError::InvalidNow {
            reason: HaltReason::Path(PathError::DestOccupied)
        }
    );
    assert_eq!(
        b.clocks[0],
        ClockState {
            window_seq: 1,
            window_open_ms: Some(T0 + 2_000),
            deadline_ms: Some(T0 + 2_000 + PVP_MS),
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 0,
        }
    );
    let out = b
        .expire(T0 + 2_000 + PVP_MS, 1, 1, &w.rules(), &mut h)
        .expect("the original window still expires");
    assert_eq!(out.events[..2], [auto_pass(1, 1), ended(1, false, false)]);
}

/// BT3.8: InvalidNow resets nothing: a valid submit after it books idle from the ORIGINAL
/// window opening.
/// Kills: an InvalidNow that refills the window (zero-cost resubmits would stall forever).
#[test]
fn an_invalid_now_resubmit_never_refills_the_window_bt3_8() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 1), (6, 6), &w, &mut h);
    refused(
        &mut b,
        T0 + 20_000,
        Side::A,
        1,
        vec![sk(LIGHT, 11)],
        &w,
        &mut h,
    );
    submit(&mut b, T0 + 25_000, 1, vec![mv(1, 3, 1)], &w, &mut h);
    assert_eq!(b.clocks[0].idle_ms_total, 23_000, "25 000 − (T0 + 2 000)");
    assert_eq!(b.clocks[0].window_seq, 2);
}

/// BT3.8: a live submit whose SECOND entry would fail is accepted: the first executes, the
/// plan halts at the second (`Path` → `Unreachable`, the destination now held).
/// Kills: InvalidNow raised for a later entry (the gate checks the first only).
#[test]
fn a_live_submit_whose_later_entry_fails_is_accepted_and_halts_there_bt3_8() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = halt_fixture(&w, &mut h);
    let out = submit(
        &mut b,
        T0 + 3_000,
        1,
        vec![sk(LIGHT, 11), mv(7, 7, 1)],
        &w,
        &mut h,
    );
    assert_eq!(
        out.events,
        vec![
            executed(1, LIGHT, vec![chip(11)]),
            halted(1, 1, HaltKind::Unreachable),
        ]
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(unit_in(&b, 1).pos, c(3, 3));
}

/// BT3.8: a live submit must carry an entry (`Empty`) and needs an open window on the unit's
/// side clock (`NoWindow`, checked first); neither changes anything.
/// Kills: an empty live submit accepted (it would execute nothing and reset the clock).
#[test]
fn a_live_submit_needs_an_entry_and_an_open_window_bt3_8() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    assert_eq!(
        refused(&mut b, T0 + 100, Side::A, 1, vec![], &w, &mut h),
        SubmitError::Empty
    );
    b.clocks[0].window_open_ms = None;
    b.clocks[0].deadline_ms = None;
    assert_eq!(
        refused(&mut b, T0 + 100, Side::A, 1, vec![], &w, &mut h),
        SubmitError::NoWindow
    );
    assert_eq!(
        refused(
            &mut b,
            T0 + 100,
            Side::A,
            1,
            vec![sk(LIGHT, 11)],
            &w,
            &mut h
        ),
        SubmitError::NoWindow
    );
}

// ===========================================================================
// BT3.9 — the idle clock through the machine
// ===========================================================================

/// BT3.9: entering `Waiting(U)` opens U's window at `now + pad`, `pad` = Σ presentation caps of
/// the events since the last Waiting: BattleStarted 2 000 + the wild's 2-tile Move 200 + its
/// Executed 400 (+ TurnEnded 0) = 2 600; the pending pad is then spent.
/// Kills: no pad; the pad counting only some events; the pad not reset after use.
#[test]
fn entering_waiting_opens_a_window_padded_by_the_presentation_caps_bt3_9() {
    let (b, out, _) = ai_first();
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_600,
            deadline_ms: T0 + 2_600 + PVE_MS,
        })
    );
    assert_eq!(
        b.clocks[0],
        ClockState {
            window_seq: 1,
            window_open_ms: Some(T0 + 2_600),
            deadline_ms: Some(T0 + 2_600 + PVE_MS),
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 0,
        }
    );
    assert_eq!(
        b.clocks[1],
        ClockState::default(),
        "a wild side's clock never runs"
    );
    assert_eq!(b.pending_pad_ms, 0);
}

/// BT3.9: the pad accumulates across transactions (a step ending `Advancing` carries its caps
/// to the next Waiting) and is capped at 5 000 when the window opens: 3 400 is kept, the worst
/// case's 7 800 opens at +5 000.
/// Kills: the pad dropped at a transaction boundary; the cap never applied.
#[test]
fn the_pad_accumulates_across_transactions_and_is_capped_at_five_seconds_bt3_9() {
    let w = World::new();
    let (mut b, _, mut h) = chain4(&w);
    assert_eq!(b.pending_pad_ms, 2_000 + 200 + 100 + 100 + 1_000);
    let t1 = T0 + 10_000;
    let pin = b.advance_pin().expect("pinned");
    let out = b.advance(t1, pin, &w.rules(), &mut h).expect("round 2");
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: t1 + 3_400,
            deadline_ms: t1 + 3_400 + PVE_MS,
        })
    );
    assert_eq!(b.pending_pad_ms, 0);

    let (mut b, _, mut h) = worst_case(&w);
    assert_eq!(b.pending_pad_ms, 2_000 + 12 * 200 + 6 * 400 + 1_000);
    let pin = b.advance_pin().expect("pinned");
    let out = b.advance(t1, pin, &w.rules(), &mut h).expect("round 2");
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: t1 + 5_000,
            deadline_ms: t1 + 5_000 + PVE_MS,
        })
    );
}

/// BT3.9: an accepted submit closes the window (booking `now − opens_at` as idle) and the
/// re-entry opens a FRESH, FULL window — not the remainder of the old one.
/// Kills: a cumulative per-unit-turn clock (the §12 Q1 alternative); the old deadline kept.
#[test]
fn re_entering_waiting_opens_a_fresh_full_window_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((3, 3), (4, 3), &w, &mut h);
    let t1 = T0 + 250_000;
    let out = submit(&mut b, t1, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out.window,
        Some(Window {
            seq: 2,
            opens_at_ms: t1 + 400,
            deadline_ms: t1 + 400 + PVE_MS,
        })
    );
    assert_eq!(b.clocks[0].idle_ms_total, 248_000);
    assert_eq!(b.clocks[0].deadline_ms, Some(t1 + 400 + PVE_MS));
}

/// BT3.9: a submit or cancel for a DIFFERENT unit (same side or the other) leaves the waiting
/// unit's clock — and both clocks and the pending pad — untouched; a pre-queue reports the
/// battle's current round.
/// Kills: any clock touched by a pre-queue or a cancel.
#[test]
fn a_submit_or_cancel_for_another_unit_leaves_the_clocks_untouched_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Pvp,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            mon(2, Side::A, 1, 2, 5, 35),
            mon(11, Side::B, 0, 5, 2, 30),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let clocks = b.clocks;
    let pad = b.pending_pad_ms;
    submit(&mut b, T0 + 7_000, 2, vec![mv(2, 6, 1)], &w, &mut h);
    assert_eq!((b.clocks, b.pending_pad_ms), (clocks, pad));
    submit(&mut b, T0 + 8_000, 11, vec![END], &w, &mut h);
    assert_eq!((b.clocks, b.pending_pad_ms), (clocks, pad));
    assert_eq!(b.cancel_queue(Side::A, 2), Ok(()));
    assert_eq!(b.cancel_queue(Side::B, 11), Ok(()));
    assert_eq!((b.clocks, b.pending_pad_ms), (clocks, pad));
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    b.state.round = 5;
    assert_eq!(
        submit(&mut b, T0 + 9_000, 2, vec![END], &w, &mut h),
        quiet(5)
    );
}

/// BT3.9: a PvP window that expires auto-passes the unit — `AutoPass{unit, strike 1}` and
/// `TurnEnded{guard false, committed false}`, no Guard though it spent nothing — and the next
/// unit starts (B's own clock opens). A fire one millisecond early is `NotDue` and changes
/// nothing; at the deadline exactly it fires.
/// Kills: expiry → `turn_end(EndTurn)` (a free Guard); `>` for `≥` at the deadline; the round
/// stalled after an auto-pass.
#[test]
fn an_expired_pvp_window_auto_passes_without_guard_and_starts_the_next_unit_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = pvp_duel(&w, &mut h);
    let deadline = T0 + 2_000 + PVP_MS;
    let before = b.clone();
    assert_eq!(
        b.expire(deadline - 1, 1, 1, &w.rules(), &mut h),
        Err(ExpireError::NotDue {
            deadline_ms: deadline
        })
    );
    assert_eq!(b, before);
    let out = b.expire(deadline, 1, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(
        out,
        StepResult {
            events: vec![auto_pass(1, 1), ended(1, false, false)],
            round: 1,
            window: Some(Window {
                seq: 1,
                opens_at_ms: deadline,
                deadline_ms: deadline + PVP_MS,
            }),
            unit_turns: 2,
            actions: 0,
        }
    );
    assert_eq!(b.turn_state, TurnState::Waiting(11));
    assert_eq!(
        b.clocks[0],
        ClockState {
            window_seq: 1,
            window_open_ms: None,
            deadline_ms: None,
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 1,
        }
    );
    let me = unit_in(&b, 1);
    assert_eq!((me.guard, me.budget), (false, TurnBudget::default()));
}

/// BT3.9: an expiry must name the waiting unit (`WrongUnit`) and its open window's seq
/// (`StaleWindow`), in that order before `NotDue`; with nothing waiting it is `NotWaiting`; an
/// unusable tuning is refused first. Every refusal changes nothing.
/// Kills: a stale fire honoured (ADR-0126 pin); the wrong unit auto-passed.
#[test]
fn an_expiry_must_name_the_waiting_unit_and_its_open_window_bt3_9() {
    let w = World::new();
    let bad = World::tuned(perturb(|t| t.guard_den = 0));
    let mut h = FakeHooks::new();
    let mut b = pvp_duel(&w, &mut h);
    let deadline = T0 + 2_000 + PVP_MS;
    let before = b.clone();
    let cases = [
        (deadline, 11, 1, &w, ExpireError::WrongUnit { waiting: 1 }),
        (deadline, 1, 2, &w, ExpireError::StaleWindow { current: 1 }),
        (deadline, 1, 0, &w, ExpireError::StaleWindow { current: 1 }),
        (T0, 11, 2, &w, ExpireError::WrongUnit { waiting: 1 }),
        (T0, 1, 2, &w, ExpireError::StaleWindow { current: 1 }),
        (
            deadline,
            1,
            1,
            &bad,
            ExpireError::Tuning(TuningError::ZeroGuardDen),
        ),
    ];
    for (now, unit_id, seq, world, want) in cases {
        assert_eq!(
            b.expire(now, unit_id, seq, &world.rules(), &mut h),
            Err(want),
            "expire({now}, {unit_id}, {seq})"
        );
        assert_eq!(b, before);
    }

    let mut idle = wild(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(11, Side::B, 0, 6, 6, 30),
    ]);
    let snapshot = idle.clone();
    assert_eq!(
        idle.expire(T0, 1, 0, &w.rules(), &mut h),
        Err(ExpireError::NotWaiting)
    );
    assert_eq!(idle, snapshot);
    let (mut advancing, _, mut h2) = chain4(&w);
    let snapshot = advancing.clone();
    assert_eq!(
        advancing.expire(T0 + 400_000, 1, 1, &w.rules(), &mut h2),
        Err(ExpireError::NotWaiting)
    );
    assert_eq!(advancing, snapshot);
}

/// BT3.9: strikes count per side and never reset; the 4th auto-pass of a side forfeits the
/// match to the OTHER side (`BattleEnd{Forfeit}`, rows voided, `Finished`), the 3rd does not.
/// Kills: forfeit at `> 4`; the winner hard-coded to one side; the battle running on.
#[test]
fn the_fourth_auto_pass_of_a_side_forfeits_the_match_to_the_other_side_bt3_9() {
    let w = World::new();
    let deadline = T0 + 2_000 + PVP_MS;
    let side_a = || {
        let mut h = FakeHooks::new();
        let (mut b, _) = drive(
            BattleKind::Pvp,
            vec![
                mon(1, Side::A, 0, 1, 1, 40),
                mon(2, Side::A, 1, 1, 5, 35),
                mon(11, Side::B, 0, 6, 6, 30),
            ],
            &World::new(),
            &mut h,
        );
        submit(&mut b, T0 + 100, 2, vec![END], &World::new(), &mut h);
        (b, h)
    };

    let (mut b, mut h) = side_a();
    b.clocks[0].autopass_count = 2;
    let out = b.expire(deadline, 1, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(
        out.events,
        vec![
            auto_pass(1, 3),
            ended(1, false, false),
            ended(2, true, true)
        ],
        "the 3rd strike does not forfeit"
    );
    assert_eq!(b.phase(), Phase::Active);
    assert_eq!(b.turn_state, TurnState::Waiting(11));

    let (mut b, mut h) = side_a();
    b.clocks[0].autopass_count = 3;
    let out = b.expire(deadline, 1, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(
        out.events,
        vec![
            auto_pass(1, 4),
            ended(1, false, false),
            battle_end(BattleOutcome::SideBWins, EndHow::Forfeit),
            voided(2),
        ]
    );
    assert_eq!(
        (b.phase(), b.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert_eq!(b.state.outcome, BattleOutcome::SideBWins);

    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Pvp,
        vec![mon(11, Side::B, 0, 6, 6, 40), mon(1, Side::A, 0, 1, 1, 30)],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(11));
    b.clocks[1].autopass_count = 3;
    let out = b.expire(deadline, 11, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(
        out.events,
        vec![
            auto_pass(11, 4),
            ended(11, false, false),
            battle_end(BattleOutcome::SideAWins, EndHow::Forfeit),
        ]
    );
    assert_eq!(b.state.outcome, BattleOutcome::SideAWins);
}

/// BT3.9: a wild window that expires auto-flees: the ONE flee rule runs through the hook (once,
/// with the validated Flee), then the battle ends `Fled` by `AutoFlee` — even though the fake
/// hook leaves the outcome Ongoing — and no strike is counted.
/// Kills: AutoPass in a wild battle; the outcome left to the hook; the flee rule bypassed.
#[test]
fn an_expired_wild_window_flees_through_the_flee_hook_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 1), (6, 6), &w, &mut h);
    let deadline = T0 + 2_000 + PVE_MS;
    let before = b.clone();
    assert_eq!(
        b.expire(deadline - 1, 1, 1, &w.rules(), &mut h),
        Err(ExpireError::NotDue {
            deadline_ms: deadline
        })
    );
    assert_eq!(b, before);
    let out = b.expire(deadline, 1, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(
        out.events,
        vec![battle_end(BattleOutcome::Fled, EndHow::AutoFlee)]
    );
    assert_eq!(
        h.resolve_calls,
        vec![(1, Validated::Flee { entry: Entry::Flee })]
    );
    assert_eq!(b.state.outcome, BattleOutcome::Fled);
    assert_eq!(
        (b.phase(), b.turn_state),
        (Phase::Finished, TurnState::NotActive)
    );
    assert_eq!(b.clocks[0].autopass_count, 0);
    assert_eq!(
        (b.clocks[0].window_open_ms, b.clocks[0].deadline_ms),
        (None, None)
    );
}

/// BT3.9: under DESIGN a unit-turn gets at most 3 windows: Move (6 → 4, window 2), Move
/// (4 → 2, window 3), Light (2 → 0) ends the turn — never a 4th window; each accepted submit
/// books its idle from its own window's opening.
/// Kills: a 4th window; idle measured from the first window.
#[test]
fn a_unit_turn_gets_at_most_three_windows_under_the_design_numbers_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 3), (6, 3), &w, &mut h);
    let t1 = T0 + 5_000;
    let out = submit(&mut b, t1, 1, vec![mv(3, 3, 1)], &w, &mut h);
    assert_eq!(out.window.map(|win| win.seq), Some(2));
    let t2 = t1 + 1_000;
    let out = submit(&mut b, t2, 1, vec![mv(5, 3, 1)], &w, &mut h);
    assert_eq!(
        out.window,
        Some(Window {
            seq: 3,
            opens_at_ms: t2 + 200,
            deadline_ms: t2 + 200 + PVE_MS,
        })
    );
    assert_eq!(b.clocks[0].windows_this_unit_turn, 3);
    let t3 = t2 + 700;
    let out = submit(&mut b, t3, 1, vec![sk(LIGHT, 11)], &w, &mut h);
    assert_eq!(
        out,
        StepResult {
            events: vec![
                executed(1, LIGHT, vec![chip(11)]),
                ended(1, false, true),
                ended(11, true, true),
                round_ended(1),
            ],
            round: 1,
            window: None,
            unit_turns: 2,
            actions: 1,
        }
    );
    assert_eq!(
        b.clocks[0],
        ClockState {
            window_seq: 3,
            window_open_ms: None,
            deadline_ms: None,
            windows_this_unit_turn: 3,
            idle_ms_total: 3_000 + 800 + 500,
            autopass_count: 0,
        }
    );
}

/// BT3.9: past the window cap (a perturbed `max_windows_per_turn: 1`) the re-entry is refused,
/// never clamped: the turn ends UNCOMMITTED (no Guard), with no AutoPass event and no strike,
/// and the round continues.
/// Kills: a window opened past the cap; the cap treated as an auto-pass (a strike).
#[test]
fn a_window_past_the_cap_ends_the_turn_uncommitted_without_a_strike_bt3_9() {
    let w = World::tuned(perturb(|t| t.max_windows_per_turn = 1));
    let mut h = FakeHooks::new();
    let mut b = drive_to_waiting((1, 3), (6, 3), &w, &mut h);
    let out = submit(&mut b, T0 + 5_000, 1, vec![mv(3, 3, 1)], &w, &mut h);
    assert_eq!(
        out.events,
        vec![
            moved(1, (1, 3), (3, 3), 2),
            ended(1, false, false),
            ended(11, true, true),
            round_ended(1),
        ]
    );
    assert_eq!(out.window, None);
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(b.clocks[0].autopass_count, 0);
    assert_eq!(
        (b.clocks[0].window_seq, b.clocks[0].windows_this_unit_turn),
        (1, 1)
    );
    assert!(!unit_in(&b, 1).guard);
}

/// BT3.9: `conclude` (a forfeit or a disconnect) ends the battle once: `BattleEnd{outcome,
/// how}`, every row voided ascending, the open window closed WITHOUT idle accounting,
/// `NotActive`; `Ongoing` is `NotAnEnd`, a second conclude `AlreadyFinished` — both no-ops.
/// Kills: a decided outcome overwritten; the window left armed; idle booked on a forfeit.
#[test]
fn conclude_ends_the_battle_once_and_closes_the_window_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let mut b = gate_battle(&w, &mut h);
    submit(&mut b, T0 + 50, 3, vec![END], &w, &mut h);
    submit(&mut b, T0 + 50, 2, vec![END], &w, &mut h);
    let before = b.clone();
    assert_eq!(
        b.conclude(BattleOutcome::Ongoing, EndHow::Forfeit),
        Err(ConcludeError::NotAnEnd)
    );
    assert_eq!(b, before);
    let out = b
        .conclude(BattleOutcome::SideBWins, EndHow::Forfeit)
        .expect("ends");
    assert_eq!(
        out,
        StepResult {
            events: vec![
                battle_end(BattleOutcome::SideBWins, EndHow::Forfeit),
                voided(2),
                voided(3),
            ],
            round: 1,
            window: None,
            unit_turns: 0,
            actions: 0,
        }
    );
    assert_eq!(
        b.clocks[0],
        ClockState {
            window_seq: 1,
            window_open_ms: None,
            deadline_ms: None,
            windows_this_unit_turn: 1,
            idle_ms_total: 0,
            autopass_count: 0,
        }
    );
    assert_eq!(
        (b.turn_state, b.phase()),
        (TurnState::NotActive, Phase::Finished)
    );
    let finished = b.clone();
    assert_eq!(
        b.conclude(BattleOutcome::SideAWins, EndHow::Forfeit),
        Err(ConcludeError::AlreadyFinished)
    );
    assert_eq!(b, finished);
    assert_eq!(b.state.outcome, BattleOutcome::SideBWins);
}

/// BT3.9: Practice runs the PvP clock — a 30 000 ms window and AutoPass on expiry.
/// Kills: `match kind { Pvp => .. }` sending Practice to the PvE budget / AutoFlee.
#[test]
fn practice_runs_the_pvp_clock_bt3_9() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, out) = drive(
        BattleKind::Practice,
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(11, Side::B, 0, 6, 6, 30)],
        &w,
        &mut h,
    );
    let deadline = T0 + 2_000 + PVP_MS;
    assert_eq!(
        out.window,
        Some(Window {
            seq: 1,
            opens_at_ms: T0 + 2_000,
            deadline_ms: deadline,
        })
    );
    let out = b.expire(deadline, 1, 1, &w.rules(), &mut h).expect("due");
    assert_eq!(out.events[..2], [auto_pass(1, 1), ended(1, false, false)]);
    assert_eq!(b.turn_state, TurnState::Waiting(11));
}

// ===========================================================================
// BT3.10 — emission only at execution; the discarded tail never appears
// ===========================================================================

/// BT3.10: a halted plan's discarded tail — the failing `TAIL → 17` and the `Move (7,6)` after
/// it — appears in NO event: no number of the tail (skill 4242, unit 17, tile 7/6) occurs
/// anywhere in the serialized events, and `PlanHalted` carries exactly `{unit, idx,
/// reason_kind}`.
/// Kills: the tail emitted (as Executed / Moved / a detailed halt reason); a halt event that
/// leaks the failing entry's payload.
#[test]
fn a_halted_plans_discarded_tail_appears_in_no_event_bt3_10() {
    let w = World::new();
    let mut h = FakeHooks::new();
    let (mut b, _) = drive(
        BattleKind::Wild,
        vec![mon(1, Side::A, 0, 1, 1, 40), mon(17, Side::B, 0, 5, 5, 30)],
        &w,
        &mut h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    let out = submit(
        &mut b,
        T0 + 4_000,
        1,
        vec![mv(3, 1, 1), sk(TAIL, 17), mv(7, 6, 1)],
        &w,
        &mut h,
    );
    assert_eq!(
        out.events,
        vec![
            moved(1, (1, 1), (3, 1), 2),
            halted(1, 1, HaltKind::Geometry)
        ]
    );
    let numbers = numbers_in(&out.events);
    for leaked in [4242u64, 17, 7, 6] {
        assert!(
            !numbers.contains(&leaked),
            "{leaked} from the discarded tail leaked into {numbers:?}"
        );
    }
    let halt = serde_json::to_value(&out.events[1]).expect("serializes");
    let mut keys: Vec<String> = halt
        .get("PlanHalted")
        .and_then(Value::as_object)
        .expect("an externally tagged PlanHalted")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(keys, vec!["idx", "reason_kind", "unit"]);
    assert_eq!(unit_in(&b, 1).pos, c(3, 1), "the tail's Move never ran");
}

/// The events that only an executed entry produces.
fn execution_events(events: &[EventPayload]) -> usize {
    count(events, |e| {
        matches!(
            e,
            EventPayload::Executed(_) | EventPayload::Moved(_) | EventPayload::ItemUsed(_)
        )
    })
}

/// BT3.10: events are emitted only at execution — every Executed / Moved / ItemUsed belongs to
/// one executed entry, so their count equals `actions`, in the worst-case step, in a chained
/// round, and in a step where a second plan halts on a shared item.
/// Kills: events emitted at submit or for halted entries; `actions` counting halted entries.
#[test]
fn events_are_emitted_only_for_executed_entries_bt3_10() {
    let w = World::new();
    let (_, out, _) = worst_case(&w);
    assert_eq!(execution_events(&out.events), usize::from(out.actions));
    assert_eq!(out.actions, 18);

    let (_, out, _) = chain4(&w);
    assert_eq!(execution_events(&out.events), usize::from(out.actions));
    assert_eq!(out.actions, 3);

    let mut h = FakeHooks::new().holding(POTION, 1);
    let mut b = wild(vec![
        mon(1, Side::A, 0, 1, 1, 40),
        mon(2, Side::A, 1, 1, 5, 35),
        mon(11, Side::B, 0, 7, 7, 30),
    ]);
    let potion = vec![use_item(POTION, ActionTarget::SelfTarget)];
    assert_eq!(
        submit(&mut b, T0 - 100, 1, potion.clone(), &w, &mut h),
        quiet(1),
        "a pre-queue emits nothing"
    );
    submit(&mut b, T0 - 100, 2, potion, &w, &mut h);
    let out = start_at(&mut b, T0, &w, &mut h);
    assert_eq!(execution_events(&out.events), 1);
    assert_eq!(out.actions, 1);
}
