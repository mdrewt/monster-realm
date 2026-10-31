//! bt-5 gating tests for `tactics::recruit` (BT5.1 - BT5.5): the forecast / roll / resolution of a
//! tactical Recruit, the party-headroom gate, the effect of a recruit on the battle, and the Flee
//! paths (which are ONE rule in the bt-3 turn machine; bt-5 adds no flee code, so BT5.5 is proven
//! by characterising `TacticalBattle` end to end).
//!
//! Every expected value is hand-derived from the plan contracts (the reviewer block R1-R11 is
//! binding) at `TacticsTuning::DESIGN`, then cross-checked against the carried rules
//! (`taming::rules::recruit_chance`, `monster::rolls`), never read back from the implementation.
//!
//! # Fixtures
//!
//! A 7x7 all-Plain board (`resolve_tests::state`). Every unit is a level-5 Water unit with 100 max
//! HP, chip defence and one melee Light skill. Side A (ids 1..=9) is the player, side B (ids
//! 11..=19) the wild pack. `RecruitHooks` is the shell model: its `validate_delegated` calls
//! `recruit_preflight`, its `resolve_delegated` calls `resolve_recruit` (an `Err` there is a shell
//! invariant breach, so it panics), and the bait bonus comes from a fixed table (BAIT 150 permille,
//! SUPER_BAIT 1000).
//!
//! # The odds example
//!
//! A wild at 20/100 HP: `hp_bonus = 80 * 500 / 100 = 400`; with BAIT (150) the permille is
//! `80 + 150 + 400 = 630`, so `pct 63 = base 8 + bait 15 + weakened 40`.
//!
//! Test names end in the criterion tag `_bt5_<k>`.

use proptest::prelude::*;

use crate::combat::type_chart::TypeChart;
use crate::combat::types::BattleOutcome;
use crate::content::Species;
use crate::monster::derive_stats;
use crate::monster::rolls::roll_individuality;
use crate::monster::rules::xp_for_level;
use crate::monster::types::{Affinity, EVs, IVs, Level, Nature, StatBlock, StatKind};
use crate::taming::rules::{recruit_chance, RECRUIT_BASE_RATE};

use super::economy::{EconomyError, Entry};
use super::events::{
    BattleEndEvent, EndHow, EventPayload, HaltKind, PlanHaltedEvent, RecruitResultEvent,
};
use super::geometry::Side;
use super::queue::{
    validate_at_pop, HaltReason, Hooks, Rules, StepResult, SubmitError, TacticalBattle, Validated,
};
use super::recruit::{
    rebuild_recruited, recruit_odds, recruit_preflight, recruit_roll_succeeds, resolve_recruit,
    RecruitError, RecruitOdds,
};
use super::resolve::{splitmix64, TacticalState, TacticalUnit, UnitState};
use super::resolve_tests::{c, chart, design, light, melee, state, unit, water, CHIP_DEF};
use super::rewards::{on_unit_defeated, Ledger, RewardError};
use super::tuning::{BattleKind, TacticsTuning};
use super::types::{
    ActionKind, ActionTarget, MoveAction, QueuedAction, RecruitAction, SkillAction, TurnState,
};

// ===========================================================================
// Fixtures
// ===========================================================================

const BID: u64 = 0x00B7_0005;
const T0: i64 = 1_000_000;
const LIGHT: u32 = 10;
/// +150 permille.
const BAIT: u32 = 502;
/// +1000 permille (the cap).
const SUPER_BAIT: u32 = 503;
const END: QueuedAction = QueuedAction::EndTurn;
const FLEE: QueuedAction = QueuedAction::Flee;

/// The shell's bait table.
fn bait_bonus_of(bait: Option<u32>) -> u16 {
    match bait {
        Some(BAIT) => 150,
        Some(SUPER_BAIT) => 1000,
        Some(_) | None => 0,
    }
}

/// A 100/100-HP chip-defence unit at `(x, y)`.
fn mon(id: u32, side: Side, slot: u8, x: u8, y: u8, speed: u16) -> TacticalUnit {
    unit(
        id,
        side,
        slot,
        c(x, y),
        water(
            100,
            CHIP_DEF,
            speed,
            vec![light(LIGHT, Affinity::Fire, melee())],
        ),
        100,
    )
}

fn with_hp(mut u: TacticalUnit, hp: u16) -> TacticalUnit {
    u.cur_hp = hp;
    u
}

fn mv(x: u8, y: u8, strides: u8) -> QueuedAction {
    QueuedAction::Move(MoveAction { x, y, strides })
}

fn sk(skill_id: u32, target: u32) -> QueuedAction {
    QueuedAction::Skill(SkillAction {
        skill_id,
        target: ActionTarget::Unit(target),
    })
}

fn rec(target: u32, bait: Option<u32>) -> QueuedAction {
    QueuedAction::Recruit(RecruitAction { target, bait })
}

fn lvl(n: u8) -> Level {
    Level::new(n).expect("a valid level")
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

    fn rules(&self) -> Rules<'_> {
        Rules {
            chart: &self.ch,
            tuning: &self.t,
        }
    }
}

/// The shell model of the three delegated hooks. The player (side A, ids below 10) owns the bag;
/// a wild owns nothing.
struct RecruitHooks {
    headroom: bool,
    /// `(item_id, count)` held by the player.
    bait: Vec<(u32, u32)>,
    take_calls: Vec<(u32, u32)>,
    resolve_calls: Vec<(u32, Validated)>,
    results: Vec<RecruitResultEvent>,
}

impl RecruitHooks {
    fn new() -> RecruitHooks {
        RecruitHooks {
            headroom: true,
            bait: Vec::new(),
            take_calls: Vec::new(),
            resolve_calls: Vec::new(),
            results: Vec::new(),
        }
    }

    fn holding(mut self, item_id: u32, count: u32) -> RecruitHooks {
        self.bait.push((item_id, count));
        self
    }

    fn held(&self, item_id: u32) -> u32 {
        self.bait
            .iter()
            .filter(|s| s.0 == item_id)
            .map(|s| s.1)
            .sum()
    }
}

impl Hooks for RecruitHooks {
    fn item_count(&self, unit: u32, item_id: u32) -> u32 {
        if unit < 10 {
            self.held(item_id)
        } else {
            0
        }
    }

    fn take_item(&mut self, unit: u32, item_id: u32) -> bool {
        self.take_calls.push((unit, item_id));
        if unit >= 10 {
            return false;
        }
        match self.bait.iter_mut().find(|s| s.0 == item_id && s.1 > 0) {
            Some(slot) => {
                slot.1 -= 1;
                true
            }
            None => false,
        }
    }

    fn recruit_headroom(&self, _unit: u32) -> bool {
        self.headroom
    }

    fn plan_ai(&self, _state: &TacticalState, _unit: u32) -> Vec<QueuedAction> {
        vec![QueuedAction::EndTurn]
    }

    fn validate_delegated(
        &self,
        state: &TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Result<(), HaltReason> {
        match validated {
            Validated::Recruit { target, bait, .. } => {
                recruit_preflight(state, unit, *target, bait_bonus_of(*bait)).map_err(|e| match e {
                    RecruitError::BaitBonus { .. } => HaltReason::ItemNotHeld {
                        item_id: bait.unwrap_or(0),
                    },
                    RecruitError::UnknownUnit { id } | RecruitError::TargetGone { id } => {
                        HaltReason::TargetGone { id }
                    }
                })
            }
            Validated::Move { .. }
            | Validated::Skill { .. }
            | Validated::Item { .. }
            | Validated::Flee { .. }
            | Validated::EndTurn => Ok(()),
        }
    }

    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Vec<EventPayload> {
        self.resolve_calls.push((unit, validated.clone()));
        match validated {
            Validated::Recruit { target, bait, .. } => {
                let ev = resolve_recruit(state, unit, *target, bait_bonus_of(*bait))
                    .expect("preflight passed, so the rule cannot refuse");
                self.results.push(ev);
                vec![EventPayload::RecruitResult(ev)]
            }
            Validated::Move { .. }
            | Validated::Skill { .. }
            | Validated::Item { .. }
            | Validated::Flee { .. }
            | Validated::EndTurn => Vec::new(),
        }
    }
}

fn battle_of(kind: BattleKind, seed: u64, units: Vec<TacticalUnit>) -> TacticalBattle {
    TacticalBattle::new(BID, state(kind, seed, units))
}

/// `units` in a battle of `kind`, started at T0.
fn drive(
    kind: BattleKind,
    seed: u64,
    units: Vec<TacticalUnit>,
    w: &World,
    h: &mut RecruitHooks,
) -> (TacticalBattle, StepResult) {
    let mut b = battle_of(kind, seed, units);
    let out = b.start(T0, &w.rules(), h).expect("the battle starts");
    (b, out)
}

/// Wild 1v1: the player's unit 1 (speed 40) at `p`, the wild 11 (speed 30, `wild_hp` of 100) at
/// `wpos`. The player is first, so the step stops at `Waiting(1)`: window 1 is
/// `[T0 + 2000, T0 + 302000]` (the BattleStarted pad), `window_seq` 1.
fn waiting_duel(
    seed: u64,
    p: (u8, u8),
    wpos: (u8, u8),
    wild_hp: u16,
    w: &World,
    h: &mut RecruitHooks,
) -> TacticalBattle {
    let (b, out) = drive(
        BattleKind::Wild,
        seed,
        vec![
            mon(1, Side::A, 0, p.0, p.1, 40),
            with_hp(mon(11, Side::B, 0, wpos.0, wpos.1, 30), wild_hp),
        ],
        w,
        h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1), "{out:?}");
    b
}

/// A 1v1 of `kind` (Pvp / Practice), adjacent, waiting on unit 1.
fn kind_duel(kind: BattleKind, w: &World, h: &mut RecruitHooks) -> TacticalBattle {
    let (b, out) = drive(
        kind,
        9,
        vec![mon(1, Side::A, 0, 2, 2, 40), mon(11, Side::B, 0, 3, 2, 30)],
        w,
        h,
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1), "{out:?}");
    b
}

/// The submit-gate board, waiting on unit 1 at (2,2):
///
/// ```text
///   1 A (2,2) speed 40   the waiting unit
///   2 A (2,5) speed 35   an ally (a player-owned, conscious target)
///  11 B (3,2) speed 30   20/100 HP, orthogonally adjacent to unit 1
///  12 B (6,6) speed 20   far
///  13 B (3,3) speed 10   diagonal to unit 1 (Manhattan 2, NOT adjacent)
/// ```
fn gate_battle(w: &World, h: &mut RecruitHooks) -> TacticalBattle {
    let (b, out) = drive(
        BattleKind::Wild,
        7,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            mon(2, Side::A, 1, 2, 5, 35),
            with_hp(mon(11, Side::B, 0, 3, 2, 30), 20),
            mon(12, Side::B, 1, 6, 6, 20),
            mon(13, Side::B, 2, 3, 3, 10),
        ],
        w,
        h,
    );
    assert_eq!(b.state.initiative, vec![1, 2, 11, 12, 13]);
    assert_eq!(b.turn_state, TurnState::Waiting(1), "{out:?}");
    b
}

/// An accepted submit by the unit's own side (live when it is the waiting unit, else a pre-queue).
fn submit(
    b: &mut TacticalBattle,
    now: i64,
    unit: u32,
    entries: Vec<QueuedAction>,
    w: &World,
    h: &mut RecruitHooks,
) -> StepResult {
    let side = b.state.unit(unit).expect("the unit exists").side;
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
    h: &mut RecruitHooks,
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

fn recruit_result(unit: u32, target: u32, success: bool, pct: u8) -> EventPayload {
    EventPayload::RecruitResult(RecruitResultEvent {
        unit,
        target,
        success,
        pct,
    })
}

fn battle_end(outcome: BattleOutcome, how: EndHow) -> EventPayload {
    EventPayload::BattleEnd(BattleEndEvent { outcome, how })
}

fn ko_count(events: &[EventPayload]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, EventPayload::Ko(_)))
        .count()
}

fn turn_ended_for(events: &[EventPayload], unit: u32) -> bool {
    events
        .iter()
        .any(|e| matches!(e, EventPayload::TurnEnded(t) if t.unit == unit))
}

/// The 100/20-HP-style raw state used by the rule-level (no turn machine) tests: player 1 at
/// (2,2), ally 2 at (2,5), wild 11 at (3,2) with 20/100 HP, wild 12 far away.
fn raw_state(seed: u64) -> TacticalState {
    state(
        BattleKind::Wild,
        seed,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            mon(2, Side::A, 1, 2, 5, 35),
            with_hp(mon(11, Side::B, 0, 3, 2, 30), 20),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
    )
}

/// 1v1 rule state: unit 1 at (2,2), wild 11 at (3,2) with `wild_hp` of 100.
fn duel_state(seed: u64, wild_hp: u16) -> TacticalState {
    state(
        BattleKind::Wild,
        seed,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            with_hp(mon(11, Side::B, 0, 3, 2, 30), wild_hp),
        ],
    )
}

/// The draw value `splitmix64(seed ^ seq) % 100`.
fn roll_of(seed: u64, seq: u64) -> u64 {
    splitmix64(seed ^ seq) % 100
}

/// A seed whose draw at `seq` is a success (`< pct`) iff `want_success`, AND whose three plausible
/// wrong draws (the plain seed, `seed + seq`, `seed ^ (seq + 1)`) all land on the OPPOSITE side, so
/// an implementation that mixes the stream differently is caught. For `pct == 100` every draw
/// succeeds, so any seed serves.
fn find_seed(pct: u64, seq: u64, want_success: bool) -> u64 {
    if pct == 100 {
        return 12_345;
    }
    let hit = |r: u64| (r < pct) == want_success;
    (1..500_000u64)
        .find(|&s| {
            hit(roll_of(s, seq))
                && !hit(roll_of(s, seq.wrapping_add(1)))
                && (seq == 0 || !hit(splitmix64(s.wrapping_add(seq)) % 100))
                && (seq == 0 || !hit(splitmix64(s) % 100))
        })
        .expect("a distinguishing seed exists")
}

// ===========================================================================
// BT5.1 - recruit availability (the gate lives in the turn machine; bt-5 characterises it)
// ===========================================================================

/// BT5.1: the turn machine refuses a Recruit that is non-adjacent (also diagonal), aimed at a
/// player-owned unit, not alone, issued with 5 of 6 AP, issued under the PvP / Practice ruleset or
/// by a wild - each with the battle byte-identical - while a legal recruit (bait or none, with or
/// without a trailing EndTurn) is admitted: the bait costs 0 extra AP.
/// Kills: a recruit rule that re-implements (or loosens) any of these gates.
#[test]
fn the_turn_machine_refuses_every_illegal_recruit_bt5_1() {
    let w = World::new();
    let now = T0 + 10;

    {
        let mut h = RecruitHooks::new().holding(BAIT, 1);
        let b = gate_battle(&w, &mut h);
        for entries in [
            vec![rec(11, None)],
            vec![rec(11, Some(BAIT))],
            vec![rec(11, None), END],
        ] {
            assert_eq!(
                b.validate_submit(Side::A, 1, &entries, &h, &w.t),
                Ok(()),
                "legal at 6 of 6 AP: {entries:?}"
            );
        }
    }

    let cases: Vec<(&str, Vec<QueuedAction>, SubmitError)> = vec![
        (
            "not adjacent",
            vec![rec(12, None)],
            SubmitError::InvalidNow {
                reason: HaltReason::NotAdjacent { target: 12 },
            },
        ),
        (
            "diagonal is not adjacent",
            vec![rec(13, None)],
            SubmitError::InvalidNow {
                reason: HaltReason::NotAdjacent { target: 13 },
            },
        ),
        (
            "a player-owned target",
            vec![rec(2, None)],
            SubmitError::InvalidNow {
                reason: HaltReason::NotWild { target: 2 },
            },
        ),
        (
            "recruit then attack",
            vec![rec(11, None), sk(LIGHT, 11)],
            SubmitError::MustBeAlone(ActionKind::Recruit),
        ),
        (
            "move then recruit",
            vec![mv(1, 2, 1), rec(11, None)],
            SubmitError::MustBeAlone(ActionKind::Recruit),
        ),
        (
            "attack then recruit",
            vec![sk(LIGHT, 11), rec(11, Some(BAIT))],
            SubmitError::MustBeAlone(ActionKind::Recruit),
        ),
    ];
    for (label, entries, want) in cases {
        let mut h = RecruitHooks::new().holding(BAIT, 1);
        let mut b = gate_battle(&w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::A, 1, entries, &w, &mut h),
            want,
            "{label}"
        );
        assert_eq!(h.held(BAIT), 1, "{label}: nothing debited");
    }

    // 5 of 6 AP: the recruit needs the whole budget.
    {
        let mut h = RecruitHooks::new().holding(BAIT, 1);
        let mut b = gate_battle(&w, &mut h);
        b.state.unit_mut(1).expect("unit 1").budget.ap = 5;
        assert_eq!(
            refused(
                &mut b,
                now,
                Side::A,
                1,
                vec![rec(11, Some(BAIT))],
                &w,
                &mut h
            ),
            SubmitError::Economy(EconomyError::NeedsFullBudget { ap: 5, required: 6 })
        );
    }

    // Under the PvP ruleset (Pvp and Practice) at submit and at pop.
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        let mut h = RecruitHooks::new();
        let mut b = kind_duel(kind, &w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::A, 1, vec![rec(11, None)], &w, &mut h),
            SubmitError::NotInPvp(ActionKind::Recruit),
            "{kind:?}"
        );
        assert_eq!(
            validate_at_pop(&b.state, 1, &rec(11, None), &h, &w.t),
            Err(HaltReason::NotAllowed(ActionKind::Recruit)),
            "{kind:?}"
        );
    }

    // A wild never recruits: no plan at submit, NotAllowed at pop.
    {
        let mut h = RecruitHooks::new();
        let mut b = gate_battle(&w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::B, 11, vec![rec(1, None)], &w, &mut h),
            SubmitError::NotPlayerOwned
        );
        assert_eq!(
            validate_at_pop(&b.state, 11, &rec(1, None), &h, &w.t),
            Err(HaltReason::NotAllowed(ActionKind::Recruit))
        );
    }
}

/// BT5.1 / R4: `recruit_preflight` checks only what the turn machine does not - bait over the
/// 1000 permille cap, the recruiter's existence, the target's existence, the target's
/// consciousness - in that order; `resolve_recruit` returns the same `Err` and leaves the state
/// byte-identical (no draw: `action_seq` included). Bait 1000 is the last legal value.
/// Kills: clamping a bad bait bonus; a draw before the check; a wrong check order; checking the
/// recruiter's consciousness (the turn machine's job).
#[test]
fn preflight_and_resolve_refuse_alike_and_leave_the_state_untouched_bt5_1() {
    #[derive(Clone, Copy, Debug)]
    enum Edit {
        None,
        TargetFainted,
        TargetRecruited,
        TargetZeroHp,
    }
    let cases: [(&str, Edit, u32, u32, u16, RecruitError); 9] = [
        (
            "bait over the cap",
            Edit::None,
            1,
            11,
            1001,
            RecruitError::BaitBonus { bait_bonus: 1001 },
        ),
        (
            "bait u16::MAX",
            Edit::None,
            1,
            11,
            u16::MAX,
            RecruitError::BaitBonus {
                bait_bonus: u16::MAX,
            },
        ),
        (
            "bait is checked first",
            Edit::None,
            99,
            98,
            1001,
            RecruitError::BaitBonus { bait_bonus: 1001 },
        ),
        (
            "unknown recruiter",
            Edit::None,
            99,
            11,
            0,
            RecruitError::UnknownUnit { id: 99 },
        ),
        (
            "the recruiter is checked before the target",
            Edit::None,
            99,
            98,
            0,
            RecruitError::UnknownUnit { id: 99 },
        ),
        (
            "unknown target",
            Edit::None,
            1,
            98,
            0,
            RecruitError::UnknownUnit { id: 98 },
        ),
        (
            "fainted target",
            Edit::TargetFainted,
            1,
            11,
            0,
            RecruitError::TargetGone { id: 11 },
        ),
        (
            "recruited target",
            Edit::TargetRecruited,
            1,
            11,
            0,
            RecruitError::TargetGone { id: 11 },
        ),
        (
            "active target at 0 HP",
            Edit::TargetZeroHp,
            1,
            11,
            0,
            RecruitError::TargetGone { id: 11 },
        ),
    ];
    for (label, edit, unit_id, target, bait, want) in cases {
        let mut st = raw_state(7);
        {
            let t = st.unit_mut(11).expect("unit 11");
            match edit {
                Edit::None => {}
                Edit::TargetFainted => {
                    t.state = UnitState::Fainted;
                    t.cur_hp = 0;
                }
                Edit::TargetRecruited => t.state = UnitState::Recruited,
                Edit::TargetZeroHp => t.cur_hp = 0,
            }
        }
        st.action_seq = 41;
        let before = st.clone();
        assert_eq!(
            recruit_preflight(&st, unit_id, target, bait),
            Err(want),
            "{label}: preflight"
        );
        assert_eq!(
            resolve_recruit(&mut st, unit_id, target, bait),
            Err(want),
            "{label}: resolve"
        );
        assert_eq!(st, before, "{label}: byte-identical, action_seq included");
    }

    let st = raw_state(7);
    for bait in [0u16, 150, 1000] {
        assert_eq!(recruit_preflight(&st, 1, 11, bait), Ok(()), "bait {bait}");
    }
}

// ===========================================================================
// BT5.2 - the forecast line items, the roll, the single draw
// ===========================================================================

/// BT5.2: exact `RecruitOdds` vectors - the 63 % example, full HP / no bait (8/8/0/0), 0-HP
/// weakening, the bait line clamped where the 1000 permille cap bites (R5: bait 1000 / 920 at full
/// HP {100, 8, 92, 0}; bait 910 at hp_bonus 10 permille {100, 8, 91, 1}), the floored carry that
/// lands in `weakened` (hp 5 + bait 5 permille -> pct 9 = 8 + 0 + 1), max_hp 0, hp over max, odd
/// divisions, u16 extremes - each also equal to `recruit_chance / 10`; bait over the cap is
/// `Err(BaitBonus)`, never clamped.
/// Kills: a wrong per-line formula; an unclamped bait line; a clamp of an out-of-domain bait.
#[test]
fn odds_line_items_match_hand_computed_vectors_bt5_2() {
    let o = |pct: u8, base: u8, bait: u8, weakened: u8| RecruitOdds {
        pct,
        base,
        bait,
        weakened,
    };
    // (max_hp, hp, bait permille) -> odds
    let rows: [(u16, u16, u16, RecruitOdds); 16] = [
        (100, 100, 0, o(8, 8, 0, 0)),
        (100, 20, 150, o(63, 8, 15, 40)),
        (100, 0, 0, o(58, 8, 0, 50)),
        (100, 0, 500, o(100, 8, 50, 42)),
        (100, 100, 1000, o(100, 8, 92, 0)),
        (100, 100, 920, o(100, 8, 92, 0)),
        (100, 100, 910, o(99, 8, 91, 0)),
        (100, 98, 910, o(100, 8, 91, 1)),
        (100, 99, 5, o(9, 8, 0, 1)),
        (100, 98, 930, o(100, 8, 92, 0)),
        (0, 0, 0, o(8, 8, 0, 0)),
        (0, 5, 100, o(18, 8, 10, 0)),
        (100, 150, 0, o(8, 8, 0, 0)),
        (3, 1, 0, o(41, 8, 0, 33)),
        (7, 3, 25, o(39, 8, 2, 29)),
        (65535, 1, 0, o(57, 8, 0, 49)),
    ];
    for (max_hp, hp, bait, want) in rows {
        assert_eq!(
            recruit_odds(max_hp, hp, bait),
            Ok(want),
            "odds for max {max_hp}, hp {hp}, bait {bait}"
        );
        assert_eq!(
            u16::from(want.pct),
            recruit_chance(max_hp, hp, RECRUIT_BASE_RATE, bait) / 10,
            "pct is the carried permille / 10 for max {max_hp}, hp {hp}, bait {bait}"
        );
        assert_eq!(
            u16::from(want.base) + u16::from(want.bait) + u16::from(want.weakened),
            u16::from(want.pct),
            "hand-written vector sums: max {max_hp}, hp {hp}, bait {bait}"
        );
    }
    for (max_hp, hp, bait) in [(100, 100, 1001), (100, 100, u16::MAX), (0, 0, 1001)] {
        assert_eq!(
            recruit_odds(max_hp, hp, bait),
            Err(RecruitError::BaitBonus { bait_bonus: bait }),
            "bait {bait} is rejected, never clamped"
        );
    }
}

proptest! {
    /// BT5.2: over the whole domain the three lines sum to the rolled pct, pct is the carried
    /// permille / 10, base is 8, and the bait line is `min(bait / 10, pct - 8)`.
    /// Kills: any line that drifts from the carried chance; a carry lost between lines.
    #[test]
    fn odds_lines_always_sum_to_the_rolled_pct_bt5_2(
        max_hp in any::<u16>(),
        hp in any::<u16>(),
        bait in 0u16..=1000,
    ) {
        let o = recruit_odds(max_hp, hp, bait).expect("in-domain bait");
        prop_assert_eq!(
            u16::from(o.base) + u16::from(o.bait) + u16::from(o.weakened),
            u16::from(o.pct)
        );
        prop_assert_eq!(
            u16::from(o.pct),
            recruit_chance(max_hp, hp, RECRUIT_BASE_RATE, bait) / 10
        );
        prop_assert_eq!(o.base, 8);
        prop_assert!(o.pct <= 100);
        prop_assert_eq!(
            u16::from(o.bait),
            (bait / 10).min(u16::from(o.pct).saturating_sub(8))
        );
    }

    /// BT5.2: every bait bonus above 1000 permille is rejected with the offending value.
    /// Kills: a clamp, a wrap, or a boundary off by one.
    #[test]
    fn a_bait_above_the_cap_is_always_rejected_bt5_2(
        max_hp in any::<u16>(),
        hp in any::<u16>(),
        bait in 1001u16..=u16::MAX,
    ) {
        prop_assert_eq!(
            recruit_odds(max_hp, hp, bait),
            Err(RecruitError::BaitBonus { bait_bonus: bait })
        );
    }
}

/// BT5.2: success iff `roll % 100 < pct` in u64 arithmetic - the boundary (pct - 1 wins, pct
/// loses), pct 0 never, pct 100 always, rolls past 2^32 and `u64::MAX` (15 mod 100).
/// Kills: `<=`; a u32 truncation of the roll; `%` replaced by another operator.
#[test]
fn the_roll_succeeds_iff_the_draw_mod_100_is_below_pct_bt5_2() {
    let rows: [(u8, u64, bool); 19] = [
        (63, 62, true),
        (63, 63, false),
        (63, 0, true),
        (63, 99, false),
        (63, 162, true),
        (63, 163, false),
        (0, 0, false),
        (0, 99, false),
        (1, 100, true),
        (1, 101, false),
        (100, 99, true),
        (100, 100, true),
        (100, 12_345, true),
        (8, 7, true),
        (8, 8, false),
        (63, 1_000_000_000_062, true),
        (63, 1_000_000_000_063, false),
        (16, u64::MAX, true),
        (15, u64::MAX, false),
    ];
    for (pct, roll, want) in rows {
        assert_eq!(
            recruit_roll_succeeds(pct, roll),
            want,
            "pct {pct}, roll {roll}"
        );
    }
}

/// BT5.2 (shown == rolled): `resolve_recruit` draws EXACTLY one value - `splitmix64(seed ^
/// action_seq)`, then `action_seq += 1` (wrapping at `u64::MAX`, and also at pct 100) - succeeds
/// iff that value `% 100 < pct`, reports the rolled pct, marks the target Recruited and drops it
/// from the initiative on success (cur_hp untouched) and changes NOTHING else on failure. The
/// seeds are searched so the right draw lands on the stated side and every plausible wrong draw
/// (plain seed, seed + seq, seed ^ (seq + 1)) lands on the other.
/// Kills: a second draw; no draw at pct 100; the wrong stream index; pct/outcome desync;
/// a mutation of the target on failure.
#[test]
fn resolve_recruit_draws_exactly_one_value_and_matches_the_forecast_bt5_2() {
    // (wild hp, bait permille, action_seq, want success, pct)
    let cases: [(u16, u16, u64, bool, u8); 9] = [
        (20, 150, 0, true, 63),
        (20, 150, 0, false, 63),
        (20, 150, 5, true, 63),
        (20, 150, 5, false, 63),
        (20, 150, u64::MAX, true, 63),
        (20, 150, u64::MAX, false, 63),
        (100, 0, 9, true, 8),
        (100, 0, 9, false, 8),
        (1, 1000, 7, true, 100),
    ];
    for (hp, bait, seq, want, pct) in cases {
        let seed = find_seed(u64::from(pct), seq, want);
        let mut st = duel_state(seed, hp);
        st.action_seq = seq;
        let before = st.clone();

        let ev = resolve_recruit(&mut st, 1, 11, bait).expect("a legal recruit");

        let success = u64::from(pct) == 100 || roll_of(seed, seq) < u64::from(pct);
        assert_eq!(success, want, "the fixture seed lands on the stated side");
        assert_eq!(
            ev,
            RecruitResultEvent {
                unit: 1,
                target: 11,
                success,
                pct,
            },
            "hp {hp}, bait {bait}, seq {seq}"
        );
        assert_eq!(
            success,
            recruit_roll_succeeds(ev.pct, splitmix64(seed ^ seq)),
            "the event is the carried roll rule applied to the one draw"
        );
        let mut expected = before.clone();
        expected.action_seq = seq.wrapping_add(1);
        if success {
            expected.unit_mut(11).expect("unit 11").state = UnitState::Recruited;
            expected.remove_from_initiative(11);
            assert!(!st.initiative.contains(&11));
        } else {
            assert!(st.initiative.contains(&11));
        }
        assert_eq!(
            st, expected,
            "exactly one draw; a failure changes nothing else (hp {hp}, bait {bait}, seq {seq})"
        );
    }
}

// ===========================================================================
// BT5.3 - party headroom
// ===========================================================================

/// BT5.3: no headroom at submit is `SubmitError::NoHeadroom`, byte-identical.
/// Kills: a recruit queued with a full party.
#[test]
fn no_headroom_at_submit_is_refused_bt5_3() {
    let w = World::new();
    let mut h = RecruitHooks::new().holding(BAIT, 1);
    h.headroom = false;
    let mut b = waiting_duel(7, (2, 2), (3, 2), 20, &w, &mut h);
    assert_eq!(
        refused(
            &mut b,
            T0 + 10,
            Side::A,
            1,
            vec![rec(11, Some(BAIT))],
            &w,
            &mut h
        ),
        SubmitError::NoHeadroom
    );
    assert_eq!(h.held(BAIT), 1);
}

/// BT5.3: headroom true at submit, false at pop (the party filled in between): the pre-queued
/// recruit halts `NoHeadroom` at idx 0, the AP is NOT charged (the unit is handed back at 6 AP
/// in `Waiting`), the bait is NOT taken, no draw happens and the target is untouched.
/// Kills: a debit before the headroom check; a draw before the gate; a recruit that succeeds anyway.
#[test]
fn headroom_lost_before_the_pop_halts_with_no_side_effects_bt5_3() {
    let w = World::new();
    let mut h = RecruitHooks::new().holding(BAIT, 1);
    // The wild is faster, so the player's turn comes second; pre-queue before the battle starts.
    let mut b = battle_of(
        BattleKind::Wild,
        7,
        vec![
            mon(1, Side::A, 0, 2, 2, 30),
            with_hp(mon(11, Side::B, 0, 3, 2, 40), 20),
        ],
    );
    submit(&mut b, T0, 1, vec![rec(11, Some(BAIT))], &w, &mut h);
    assert!(b.plan(1).is_some(), "the recruit is stored");
    h.headroom = false;

    let out = b
        .start(T0 + 1, &w.rules(), &mut h)
        .expect("the battle starts");

    assert!(
        out.events
            .contains(&EventPayload::PlanHalted(PlanHaltedEvent {
                unit: 1,
                idx: 0,
                reason_kind: HaltKind::NoHeadroom,
            })),
        "{:?}",
        out.events
    );
    assert!(
        !out.events
            .iter()
            .any(|e| matches!(e, EventPayload::RecruitResult(_))),
        "no recruit result"
    );
    assert_eq!(b.turn_state, TurnState::Waiting(1), "handed back live");
    assert_eq!(
        b.state.unit(1).expect("unit 1").budget.ap,
        6,
        "AP not charged"
    );
    assert_eq!(h.held(BAIT), 1, "bait not taken");
    assert!(h.take_calls.is_empty(), "no debit was attempted");
    assert!(h.resolve_calls.is_empty(), "the rule never ran");
    assert_eq!(b.state.action_seq, 0, "no draw");
    let target = b.state.unit(11).expect("unit 11");
    assert_eq!(target.state, UnitState::Active);
    assert_eq!(target.cur_hp, 20);
    assert!(b.state.initiative.contains(&11));
}

// ===========================================================================
// BT5.4 - what a recruit does to the battle
// ===========================================================================

/// BT5.4 (success, last wild): the target is `Recruited` with its cur_hp untouched in the state,
/// gone from the initiative, NO `Ko` event is emitted, the bait is debited once, one draw is
/// consumed, the recruit result carries the rolled pct (63), and recruiting the last wild ends the
/// battle `SideAWins / SideEmpty`. A ledger fed every Ko of the step stays empty, and the recruited
/// unit is `NotDefeated` for the reward hook (a recruit never pays).
/// Kills: a recruit that faints the target (a Ko + rewards); a state left Active; a missing end.
#[test]
fn recruiting_the_last_wild_ends_the_battle_without_a_ko_bt5_4() {
    let w = World::new();
    let seed = find_seed(63, 0, true);
    let mut h = RecruitHooks::new().holding(BAIT, 1);
    let mut b = waiting_duel(seed, (2, 2), (3, 2), 20, &w, &mut h);

    let out = submit(&mut b, T0 + 10, 1, vec![rec(11, Some(BAIT))], &w, &mut h);

    assert!(
        out.events.contains(&recruit_result(1, 11, true, 63)),
        "{:?}",
        out.events
    );
    assert!(
        out.events
            .contains(&battle_end(BattleOutcome::SideAWins, EndHow::SideEmpty)),
        "{:?}",
        out.events
    );
    assert_eq!(ko_count(&out.events), 0, "a recruit is not a KO");
    let target = b.state.unit(11).expect("unit 11");
    assert_eq!(target.state, UnitState::Recruited);
    assert_eq!(target.cur_hp, 20, "cur_hp untouched in the state");
    assert!(!b.state.initiative.contains(&11));
    assert!(!b.state.queued.contains(&11));
    assert_eq!(b.state.outcome, BattleOutcome::SideAWins);
    assert_eq!(b.turn_state, TurnState::NotActive);
    assert_eq!(b.state.action_seq, 1, "exactly one draw");
    assert_eq!(h.take_calls, vec![(1, BAIT)], "bait debited once");
    assert_eq!(h.held(BAIT), 0);

    let mut ledger = Ledger::default();
    for e in &out.events {
        if let EventPayload::Ko(k) = e {
            on_unit_defeated(&mut ledger, &b.state, 1, k.unit, 335).expect("a KO credits");
        }
    }
    assert_eq!(ledger, Ledger::default(), "no Ko, so nothing was earned");
    assert_eq!(
        on_unit_defeated(&mut ledger, &b.state, 1, 11, 335),
        Err(RewardError::NotDefeated { id: 11 })
    );
    assert_eq!(ledger, Ledger::default());
}

/// BT5.4 (success, a pack): the battle goes on, the recruited unit's turn is skipped in the same
/// round, the next round's initiative excludes it (`[1, 12]`), it never acts again, and no Ko
/// appears in any step.
/// Kills: a recruited unit that re-enters the initiative; a rebuilt order that counts it.
#[test]
fn a_recruited_unit_never_re_enters_a_later_round_bt5_4() {
    let w = World::new();
    let seed = find_seed(63, 0, true);
    let mut h = RecruitHooks::new().holding(BAIT, 1);
    let (mut b, _) = drive(
        BattleKind::Wild,
        seed,
        vec![
            mon(1, Side::A, 0, 2, 2, 40),
            with_hp(mon(11, Side::B, 0, 3, 2, 30), 20),
            mon(12, Side::B, 1, 6, 6, 20),
        ],
        &w,
        &mut h,
    );
    assert_eq!(b.state.initiative, vec![1, 11, 12]);

    let out = submit(&mut b, T0 + 10, 1, vec![rec(11, Some(BAIT))], &w, &mut h);

    assert!(
        out.events.contains(&recruit_result(1, 11, true, 63)),
        "{:?}",
        out.events
    );
    assert_eq!(b.state.outcome, BattleOutcome::Ongoing);
    assert_eq!(b.turn_state, TurnState::Advancing);
    assert_eq!(b.state.round, 2);
    assert_eq!(
        b.state.initiative,
        vec![1, 12],
        "round 2 excludes the recruit"
    );
    assert!(
        !turn_ended_for(&out.events, 11),
        "the recruited unit took no turn"
    );

    let pin = b.advance_pin().expect("a round boundary");
    let step = b
        .advance(T0 + 400_000, pin, &w.rules(), &mut h)
        .expect("the next round starts");
    assert_eq!(b.turn_state, TurnState::Waiting(1));
    assert_eq!(b.state.initiative, vec![1, 12]);
    assert!(!turn_ended_for(&step.events, 11));
    assert_eq!(ko_count(&out.events) + ko_count(&step.events), 0);
    let target = b.state.unit(11).expect("unit 11");
    assert_eq!((target.state, target.cur_hp), (UnitState::Recruited, 20));
}

/// BT5.4 (failure): the turn is consumed (the unit's TurnEnded, AP 0), the bait is debited once,
/// the target is unchanged and still in the order, and a second attempt next round forecasts and
/// rolls the SAME pct (63) from the next stream index.
/// Kills: a failure that refunds the bait or keeps the turn; odds that drift after a failure.
#[test]
fn a_failed_recruit_consumes_the_turn_and_repeats_the_same_odds_bt5_4() {
    let w = World::new();
    let seed = find_seed(63, 0, false);
    let mut h = RecruitHooks::new().holding(BAIT, 2);
    let mut b = waiting_duel(seed, (2, 2), (3, 2), 20, &w, &mut h);

    let out = submit(&mut b, T0 + 10, 1, vec![rec(11, Some(BAIT))], &w, &mut h);

    assert!(
        out.events.contains(&recruit_result(1, 11, false, 63)),
        "{:?}",
        out.events
    );
    assert!(turn_ended_for(&out.events, 1), "the turn is consumed");
    assert_eq!(b.state.unit(1).expect("unit 1").budget.ap, 0);
    assert_eq!(h.take_calls, vec![(1, BAIT)], "bait debited once");
    assert_eq!(h.held(BAIT), 1);
    assert_eq!(b.state.action_seq, 1);
    assert_eq!(b.state.outcome, BattleOutcome::Ongoing);
    let target = b.state.unit(11).expect("unit 11");
    assert_eq!((target.state, target.cur_hp), (UnitState::Active, 20));
    assert!(b.state.initiative.contains(&11));
    assert_eq!(ko_count(&out.events), 0);

    let pin = b.advance_pin().expect("a round boundary");
    b.advance(T0 + 400_000, pin, &w.rules(), &mut h)
        .expect("the next round starts");
    assert_eq!(b.turn_state, TurnState::Waiting(1));

    let again = submit(
        &mut b,
        T0 + 410_000,
        1,
        vec![rec(11, Some(BAIT))],
        &w,
        &mut h,
    );

    let second_wins = roll_of(seed, 1) < 63;
    assert!(
        again
            .events
            .contains(&recruit_result(1, 11, second_wins, 63)),
        "same pct, next stream index: {:?}",
        again.events
    );
    assert_eq!(h.take_calls, vec![(1, BAIT), (1, BAIT)]);
    assert_eq!(h.held(BAIT), 0);
    assert_eq!(b.state.action_seq, 2);
}

fn species() -> Species {
    Species {
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
        ability: None,
        tier: 0,
    }
}

/// BT5.4: `rebuild_recruited(seed, species, level)` is the recruited monster itself: the exact
/// genes of the wild's seed (hard-coded known answers for seeds 0, 1 and 0xCAFE_BABE, and equal to
/// the carried `roll_individuality`), the target level, full HP, zero EVs / essence / trust /
/// quality time, `xp_for_level(level)` (no battle XP), no nickname, no party slot.
/// Kills: a rebuild from a different seed or level; partial HP; granted battle XP or essence.
#[test]
fn rebuild_recruited_is_the_exact_wild_at_full_hp_bt5_4() {
    let sp = species();
    let cases: [(u32, [u8; 6], u8, u8); 3] = [
        (0, [14, 19, 12, 31, 11, 29], 18, 5),
        (1, [11, 16, 4, 7, 24, 9], 19, 12),
        (0xCAFE_BABE, [7, 19, 14, 19, 10, 29], 22, 100),
    ];
    for (seed, iv, nature_idx, level) in cases {
        let m = rebuild_recruited(seed, &sp, lvl(level));
        let want_ivs = IVs::new(iv[0], iv[1], iv[2], iv[3], iv[4], iv[5]).expect("legal IVs");
        assert_eq!(m.ivs, want_ivs, "IVs for seed {seed:#x}");
        assert_eq!(
            m.nature,
            Nature::from_index(nature_idx),
            "nature for seed {seed:#x}"
        );
        let (carried_ivs, carried_nature) = roll_individuality(seed);
        assert_eq!(m.ivs, carried_ivs);
        assert_eq!(m.nature, carried_nature);

        assert_eq!(m.species_id, sp.id);
        assert_eq!(m.level.as_u8(), level);
        assert_eq!(
            m.xp.value(),
            xp_for_level(lvl(level)).value(),
            "no battle XP"
        );
        assert_eq!(m.evs, EVs::zero());
        assert_eq!(m.essence, [0u32; 8]);
        assert_eq!(m.trust_favorable_count, 0);
        assert_eq!(m.trust_unfavorable_count, 0);
        assert_eq!(m.quality_time_ticks_total, 0);
        assert!(m.nickname.is_none());
        assert!(m.party_slot.is_none());

        let stats = derive_stats(&sp.base_stats, &m.ivs, &m.evs, &m.nature, lvl(level));
        assert_eq!(m.derived_stats, stats);
        assert_eq!(m.current_hp, stats.get(StatKind::Hp), "full HP");
        assert!(m.current_hp > 0);
    }
    let zero = rebuild_recruited(0, &sp, lvl(5));
    let one = rebuild_recruited(1, &sp, lvl(5));
    assert_ne!(zero.ivs, one.ivs, "the seed is the individuality");
}

// ===========================================================================
// BT5.5 - Flee: ONE outcome (Fled) however the battle is left
// ===========================================================================

/// BT5.5: a voluntary Flee ends the battle `Fled / Fled` from any tile - adjacent to the wild,
/// across the board, in a corner - draws nothing, and runs the flee hook exactly once with the
/// validated Flee entry.
/// Kills: a flee that depends on position; a flee that draws a roll; a flee without the outcome.
#[test]
fn a_voluntary_flee_ends_the_battle_fled_from_any_tile_bt5_5() {
    let w = World::new();
    for (p, wpos) in [
        ((2u8, 2u8), (3u8, 2u8)),
        ((0, 0), (6, 6)),
        ((5, 3), (1, 4)),
        ((6, 0), (0, 6)),
    ] {
        let mut h = RecruitHooks::new();
        let mut b = waiting_duel(7, p, wpos, 100, &w, &mut h);

        let out = submit(&mut b, T0 + 10, 1, vec![FLEE], &w, &mut h);

        assert!(
            out.events
                .contains(&battle_end(BattleOutcome::Fled, EndHow::Fled)),
            "from {p:?}: {:?}",
            out.events
        );
        assert_eq!(b.state.outcome, BattleOutcome::Fled, "from {p:?}");
        assert_eq!(b.turn_state, TurnState::NotActive);
        assert_eq!(b.state.action_seq, 0, "no draw");
        assert_eq!(
            h.resolve_calls,
            vec![(1, Validated::Flee { entry: Entry::Flee })],
            "the flee hook ran once"
        );
    }
}

/// BT5.5: Flee is refused alongside another entry, at 5 of 6 AP, under the PvP / Practice
/// ruleset and for a wild; the legal forms (alone, or with a trailing EndTurn) are admitted.
/// Kills: a flee rule that loosens the bt-3 gate.
#[test]
fn flee_is_refused_unless_alone_at_full_ap_and_in_a_wild_battle_bt5_5() {
    let w = World::new();
    let now = T0 + 10;
    {
        let mut h = RecruitHooks::new();
        let b = gate_battle(&w, &mut h);
        for entries in [vec![FLEE], vec![FLEE, END]] {
            assert_eq!(
                b.validate_submit(Side::A, 1, &entries, &h, &w.t),
                Ok(()),
                "{entries:?}"
            );
        }
    }
    for (label, entries) in [
        ("flee then attack", vec![FLEE, sk(LIGHT, 11)]),
        ("move then flee", vec![mv(1, 2, 1), FLEE]),
    ] {
        let mut h = RecruitHooks::new();
        let mut b = gate_battle(&w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::A, 1, entries, &w, &mut h),
            SubmitError::MustBeAlone(ActionKind::Flee),
            "{label}"
        );
    }
    {
        let mut h = RecruitHooks::new();
        let mut b = gate_battle(&w, &mut h);
        b.state.unit_mut(1).expect("unit 1").budget.ap = 5;
        assert_eq!(
            refused(&mut b, now, Side::A, 1, vec![FLEE], &w, &mut h),
            SubmitError::Economy(EconomyError::NeedsFullBudget { ap: 5, required: 6 })
        );
    }
    for kind in [BattleKind::Pvp, BattleKind::Practice] {
        let mut h = RecruitHooks::new();
        let mut b = kind_duel(kind, &w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::A, 1, vec![FLEE], &w, &mut h),
            SubmitError::NotInPvp(ActionKind::Flee),
            "{kind:?}"
        );
        assert_eq!(
            validate_at_pop(&b.state, 1, &FLEE, &h, &w.t),
            Err(HaltReason::NotAllowed(ActionKind::Flee)),
            "{kind:?}"
        );
    }
    {
        let mut h = RecruitHooks::new();
        let mut b = gate_battle(&w, &mut h);
        assert_eq!(
            refused(&mut b, now, Side::B, 11, vec![FLEE], &w, &mut h),
            SubmitError::NotPlayerOwned
        );
        assert_eq!(
            validate_at_pop(&b.state, 11, &FLEE, &h, &w.t),
            Err(HaltReason::NotAllowed(ActionKind::Flee))
        );
    }
}

/// BT5.5: every way a wild battle is left without a winner - the voluntary flee, the idle-clock
/// AutoFlee (`expire` at the deadline), the wild round cap, and a disconnect (`conclude`) - leaves
/// the outcome `Fled`, emits `BattleEnd{Fled, how}` with that path's `EndHow`, draws nothing and
/// returns the machine to `NotActive`. (R6: a shared outcome, not shared code.)
/// Kills: a path that records a different outcome, or none.
#[test]
fn every_flee_path_leaves_the_outcome_fled_bt5_5() {
    let w = World::new();
    let mut paths: Vec<(&str, TacticalBattle, StepResult, EndHow)> = Vec::new();

    {
        let mut h = RecruitHooks::new();
        let mut b = waiting_duel(7, (2, 2), (3, 2), 100, &w, &mut h);
        let out = submit(&mut b, T0 + 10, 1, vec![FLEE], &w, &mut h);
        paths.push(("voluntary", b, out, EndHow::Fled));
    }
    {
        let mut h = RecruitHooks::new();
        let mut b = waiting_duel(7, (2, 2), (3, 2), 100, &w, &mut h);
        let out = b
            .expire(T0 + 302_000, 1, 1, &w.rules(), &mut h)
            .expect("the window is due at its deadline");
        paths.push(("idle clock", b, out, EndHow::AutoFlee));
    }
    {
        let mut h = RecruitHooks::new();
        let mut b = battle_of(
            BattleKind::Wild,
            7,
            vec![mon(1, Side::A, 0, 2, 2, 40), mon(11, Side::B, 0, 3, 2, 30)],
        );
        b.state.round = 30;
        b.state.rebuild_initiative();
        submit(&mut b, T0, 1, vec![END], &w, &mut h);
        let out = b.start(T0, &w.rules(), &mut h).expect("the battle starts");
        paths.push(("round cap", b, out, EndHow::RoundCap));
    }
    {
        let mut h = RecruitHooks::new();
        let mut b = waiting_duel(7, (2, 2), (3, 2), 100, &w, &mut h);
        let out = b
            .conclude(BattleOutcome::Fled, EndHow::AutoFlee)
            .expect("an ongoing battle can be concluded");
        paths.push(("disconnect", b, out, EndHow::AutoFlee));
    }

    for (label, b, out, how) in paths {
        assert_eq!(b.state.outcome, BattleOutcome::Fled, "{label}");
        assert!(
            out.events.contains(&battle_end(BattleOutcome::Fled, how)),
            "{label}: {:?}",
            out.events
        );
        assert_eq!(b.turn_state, TurnState::NotActive, "{label}");
        assert_eq!(b.state.action_seq, 0, "{label}: no draw");
    }
}
