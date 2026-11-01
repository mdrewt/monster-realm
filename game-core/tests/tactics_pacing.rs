//! bt-13 BT13.1 — the pacing simulation gate (spec M-battle-tactics `### bt-13`, design §10).
//!
//! The §10 reference fights are simulated against the REAL rules: wild 1v1 on the 7x7 open field,
//! wild 1v1 on the recruit path (7x7), and wild 3v3 on the 8x8 open field, each under both STAB
//! mixes. A scripted player policy (side A, the bt-4 planner itself in `Stance::Aggressive`, plus
//! the recruit cell's two overrides) plays the bt-4 wild AI (side B). Every fight is a pure
//! function of `(case, seed)` — no ambient RNG, no clock: the roll stream is
//! `TacticalState::seed`, the clock is a fixed 1 000 ms step per input, and `expire` is never
//! called. Only the public `game_core` API is used.
//!
//! WHY THE MEDIAN. The design's §10 figures are expected (central) values and its targets are
//! medians, so the honest reading of "at or under the design's pessimistic column plus one" is on
//! the MEDIAN round count: 1v1 <= 7, recruit <= 8, 3v3 <= 7. `median = sorted[N / 2]` (the UPPER
//! median for an even N), `p90 = sorted[N * 9 / 10]`; a stalling minority is caught by `p90 <=
//! 2 x bound`, and a fight that never ends by the hard caps (round > 30 or > 2 000 inputs, which
//! panic with the seed — never a silent pass).
//!
//! CONVENTIONS.
//! - Rounds = `TacticalState::round` at the end of the fight; it is cross-checked against
//!   1 + the number of round boundaries crossed (`RoundEnded` events, minus the one a fight decided
//!   by the upkeep itself emits without crossing, and the number of `advance` inputs).
//! - Unit-turns = the number of `TurnEnded` events, plus one when the fight ended mid-turn (the
//!   deciding unit never reaches its `TurnEnded`: `queue::finish`). A fight ended by the upkeep has
//!   a `RoundEnded` in its final step and no open turn. `StepResult::unit_turns` is NOT summed: it
//!   is a chain-bound counter that counts the continuing live unit twice.
//! - Both sides are the same battler (species 10, same level, neutral genes), so the sides are
//!   symmetric and either may win; the player win rate is REPORTED, not asserted. Every fight must
//!   end by elimination or recruit (never Fled / Forfeit / the round cap): the losing side has no
//!   conscious unit.
//! - STAB is a controlled variable. Only the unit `affinity` and each kit skill's `affinity` are
//!   overridden (power, accuracy, geometry, status stay content). Every attack in the fight is
//!   NEUTRAL on the real type chart in both directions; the wild side never has STAB; the player
//!   side has none in the NoStab mix and STAB on both skills in the Stab mix.
//! - The 8x8 map's closest opposing spawns are 6 apart (the design's table assumes 5); the report
//!   says so and the test only requires >= 4.
//! - The recruit cell's no-overkill rule (a Heavy aimed at a wild under half HP is replaced by the
//!   Light when the Light can hit the same target from the same tile) applies to that cell ONLY;
//!   the kill cells play the planner's plan unchanged.
//!
//! Run with `--no-capture` to read the per-cell report lines.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    clippy::too_many_lines,
    clippy::cast_precision_loss
)]

use std::sync::OnceLock;

use game_core::tactics::{
    build_kits, deploy_unit, is_adjacent, load_battle_maps, load_tactics_skills,
    load_tactics_species, load_tactics_tuning, manhattan, plan as ai_plan, recruit_odds,
    recruit_preflight, resolve_recruit, target_set, ActionKind, ActionTarget, BattleKind,
    BattleMapEntry, Cell, EventPayload, HaltReason, HitEffectiveness, Hooks, Phase, QueuedAction,
    RecruitAction, RecruitError, Rules, Side, SkillAction, SpeciesTactics, Stance, StepResult,
    TacticalBattle, TacticalState, TacticsTuning, Tier, TurnState, UnitKit, UnitState, Validated,
};
use game_core::{
    derive_stats, load_items, load_skills, load_species, load_type_chart, Affinity, BattleOutcome,
    EVs, IVs, Level, Nature, NatureKind, StatBlock, TypeChart,
};

// ===========================================================================
// Constants
// ===========================================================================

/// Umbrafang: Aggressive, Nimble, kit (11 Toxic Sting Light 1-2, 2 Fire Fang Heavy melee).
const SPECIES_ID: u32 = 10;
/// Item 1 "Lure Berry": the bait (`recruit_bonus` 150 per mille), design §5's example.
const BAIT_ID: u32 = 1;
const BAIT_BONUS: u16 = 150;
const BAIT_STOCK: u32 = 99;
/// Side A unit ids are `1..=n`; side B (the wilds) are `WILD_BASE + 1..=WILD_BASE + n`.
const WILD_BASE: u32 = 100;
/// The design's reference HP (§10): the level is the one whose derived HP is closest to it.
const REFERENCE_HP: i32 = 58;
const SEEDS: std::ops::RangeInclusive<u64> = 1..=32;
const TICK_MS: i64 = 1_000;
const INPUT_CAP: u32 = 2_000;
const ROUND_CAP: u16 = 30;
/// Design §5: weaken until the wild is under a quarter HP, then recruit.
const RECRUIT_BELOW_PERMILLE: u32 = 250;

// ===========================================================================
// Content (real loaders, parsed once per process)
// ===========================================================================

struct Content {
    tuning: TacticsTuning,
    chart: TypeChart,
    kit: SpeciesTactics,
    level: u8,
    stats: StatBlock,
    maps: Vec<BattleMapEntry>,
}

static CONTENT: OnceLock<Content> = OnceLock::new();

fn content() -> &'static Content {
    CONTENT.get_or_init(Content::load)
}

impl Content {
    fn load() -> Content {
        let tuning = load_tactics_tuning().expect("tactics tuning content loads");
        let chart = TypeChart::new(&load_type_chart().expect("type chart content loads"));
        let species = load_species().expect("species content loads");
        let skills = load_skills().expect("skill content loads");
        let kits = build_kits(
            &species,
            &skills,
            &load_tactics_skills().expect("tactics skill content loads"),
            &load_tactics_species().expect("tactics species content loads"),
        )
        .expect("the shipped kits join");
        let kit = kits
            .into_iter()
            .find(|k| k.species_id == SPECIES_ID)
            .expect("the reference species has a kit");
        assert_eq!(
            kit.stance,
            Stance::Aggressive,
            "PRECONDITION: the reference battler is Aggressive"
        );
        assert!(
            kit.light.geometry.range_min <= 1,
            "PRECONDITION: the Light reaches adjacent tiles (range_min {}), so the recruit cell's \
             Heavy -> Light swap is legal from the Heavy's own tile",
            kit.light.geometry.range_min
        );

        // Neutral genes, the level whose HP is closest to the design's 58.
        let base = species
            .iter()
            .find(|s| s.id == SPECIES_ID)
            .expect("the reference species is in content")
            .base_stats;
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).expect("15 is a legal IV");
        let evs = EVs::zero();
        let nature = Nature::new(NatureKind::Hardy);
        let (level, stats) = (1..=100u8)
            .map(|l| {
                let level = Level::new(l).expect("1..=100 is a level");
                (l, derive_stats(&base, &ivs, &evs, &nature, level))
            })
            .min_by_key(|(l, s)| ((i32::from(s.hp) - REFERENCE_HP).abs(), *l))
            .expect("there is a level");
        assert!(
            (50..=66).contains(&stats.hp),
            "PRECONDITION: the reference battler's HP at level {level} is {} (want 50..=66)",
            stats.hp
        );

        let items = load_items().expect("item content loads");
        let bait = items
            .iter()
            .find(|i| i.id == BAIT_ID)
            .expect("item 1 is in content");
        assert_eq!(bait.name, "Lure Berry", "PRECONDITION: item 1 is the bait");
        assert_eq!(
            bait.recruit_bonus, BAIT_BONUS,
            "PRECONDITION: the bait is worth 150 per mille"
        );

        Content {
            tuning,
            chart,
            kit,
            level,
            stats,
            maps: load_battle_maps().expect("battle map content loads"),
        }
    }

    fn map(&self, id: u32) -> &BattleMapEntry {
        self.maps
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("battle map {id} is in content"))
    }

    /// The reference battler with the given unit and skill affinities (the only overrides).
    fn unit_kit(&self, affinity: Affinity, skill_affinity: Affinity) -> UnitKit {
        let mut light = self.kit.light.clone();
        let mut heavy = self.kit.heavy.clone();
        light.affinity = skill_affinity;
        heavy.affinity = skill_affinity;
        UnitKit {
            species_id: SPECIES_ID,
            affinity,
            level: self.level,
            stats: self.stats,
            base_speed: self.kit.base_speed,
            class: self.kit.movement,
            skills: vec![light, heavy],
        }
    }
}

// ===========================================================================
// Cases: scenario x STAB mix
// ===========================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mix {
    NoStab,
    Stab,
}

/// `(unit affinity, skill affinity)` of the wild side in both mixes: a fixed no-STAB opponent.
const WILD_AFFINITIES: (Affinity, Affinity) = (Affinity::Electric, Affinity::Wind);

impl Mix {
    /// `(unit affinity, skill affinity)` of the player side. Neutral against the wild both ways on
    /// the shipped chart: Wind -> Electric, Fire -> Electric and Wind -> Fire are all unlisted.
    fn player(self) -> (Affinity, Affinity) {
        match self {
            Mix::NoStab => (Affinity::Electric, Affinity::Wind),
            Mix::Stab => (Affinity::Fire, Affinity::Fire),
        }
    }
}

#[derive(Clone, Copy)]
struct Scenario {
    name: &'static str,
    map_id: u32,
    side: u8,
    per_side: usize,
    recruit: bool,
    /// The design §10 pessimistic column plus one (the median bound).
    bound: u16,
}

const ONE_V_ONE: Scenario = Scenario {
    name: "wild 1v1 7x7",
    map_id: 1,
    side: 7,
    per_side: 1,
    recruit: false,
    bound: 7,
};
const RECRUIT: Scenario = Scenario {
    name: "wild 1v1 recruit 7x7",
    map_id: 1,
    side: 7,
    per_side: 1,
    recruit: true,
    bound: 8,
};
const THREE_V_THREE: Scenario = Scenario {
    name: "wild 3v3 8x8",
    map_id: 4,
    side: 8,
    per_side: 3,
    recruit: false,
    bound: 7,
};

#[derive(Clone, Copy)]
struct Case {
    scenario: Scenario,
    mix: Mix,
}

/// The map is the size and spacing the scenario claims, and the STAB mix is what it says it is on
/// the real chart and the built kits (a precondition, not an assumption).
fn assert_preconditions(c: &Content, case: Case) {
    let entry = c.map(case.scenario.map_id);
    assert!(!entry.pvp, "{}: a PvE map", case.scenario.name);
    assert_eq!(
        (entry.map.width, entry.map.height),
        (case.scenario.side, case.scenario.side),
        "{}: map {} is {}x{}",
        case.scenario.name,
        case.scenario.map_id,
        case.scenario.side,
        case.scenario.side
    );
    let n = case.scenario.per_side;
    assert!(
        entry.map.spawn_a.len() >= n && entry.map.spawn_b.len() >= n,
        "{}: the map has {n} spawns a side",
        case.scenario.name
    );
    let closest = (0..n)
        .flat_map(|i| (0..n).map(move |j| (i, j)))
        .map(|(i, j)| manhattan(entry.map.spawn_a[i], entry.map.spawn_b[j]))
        .min()
        .expect("a spawn pair");
    assert!(
        closest >= 4,
        "{}: the closest opposing spawns are {closest} apart (want >= 4)",
        case.scenario.name
    );
    if case.scenario.side == 7 {
        assert_eq!(
            manhattan(entry.map.spawn_a[0], entry.map.spawn_b[0]),
            4,
            "{}: slot 0 faces slot 0 across 4 tiles",
            case.scenario.name
        );
    }

    let (player_aff, player_skill) = case.mix.player();
    let (wild_aff, wild_skill) = WILD_AFFINITIES;
    assert_eq!(
        c.chart.effectiveness(player_skill, wild_aff),
        10,
        "{:?}: the player's attacks are neutral on the wild",
        case.mix
    );
    assert_eq!(
        c.chart.effectiveness(wild_skill, player_aff),
        10,
        "{:?}: the wild's attacks are neutral on the player",
        case.mix
    );
    for s in &c.unit_kit(player_aff, player_skill).skills {
        assert_eq!(
            s.affinity == player_aff,
            case.mix == Mix::Stab,
            "{:?}: the player's skill {} has STAB iff the mix is Stab",
            case.mix,
            s.skill_id
        );
    }
    for s in &c.unit_kit(wild_aff, wild_skill).skills {
        assert_ne!(
            s.affinity, wild_aff,
            "the wild's skill {} never has STAB",
            s.skill_id
        );
    }
}

// ===========================================================================
// The hooks (a minimal mirror of the server's `ShellHooks`)
// ===========================================================================

/// One resolved recruit attempt, as the hook saw it (the pre-roll HP, the odds rolled).
#[derive(Clone, Debug, PartialEq)]
struct Attempt {
    cur_hp: u16,
    max_hp: u16,
    hp_permille: u32,
    pct: u8,
    expected_pct: u8,
    success: bool,
}

struct PacingHooks<'a> {
    tuning: &'a TacticsTuning,
    /// `(unit id, stance, spawn tile)` of every wild.
    wilds: Vec<(u32, Stance, Cell)>,
    bait_stock: u32,
    attempts: Vec<Attempt>,
}

/// The bait's bonus (per mille): none for no bait, 150 for the Lure Berry, a halt for anything else.
fn bonus_of(bait: Option<u32>) -> Result<u16, HaltReason> {
    match bait {
        None => Ok(0),
        Some(BAIT_ID) => Ok(BAIT_BONUS),
        Some(item_id) => Err(HaltReason::ItemNotHeld { item_id }),
    }
}

impl Hooks for PacingHooks<'_> {
    fn item_count(&self, _unit: u32, item_id: u32) -> u32 {
        if item_id == BAIT_ID {
            self.bait_stock
        } else {
            0
        }
    }

    fn take_item(&mut self, _unit: u32, item_id: u32) -> bool {
        if item_id == BAIT_ID && self.bait_stock > 0 {
            self.bait_stock -= 1;
            true
        } else {
            false
        }
    }

    fn recruit_headroom(&self, _unit: u32) -> bool {
        true
    }

    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction> {
        match self.wilds.iter().find(|(id, _, _)| *id == unit) {
            Some(&(_, stance, spawn)) => ai_plan(state, unit, stance, spawn, self.tuning),
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
            Validated::Item { .. } => Err(HaltReason::NotAllowed(ActionKind::Item)),
            Validated::Recruit { target, bait, .. } => {
                let bonus = bonus_of(*bait)?;
                recruit_preflight(state, unit, *target, bonus).map_err(|e| match e {
                    RecruitError::BaitBonus { .. } => HaltReason::ItemNotHeld {
                        item_id: bait.unwrap_or(0),
                    },
                    RecruitError::UnknownUnit { id } | RecruitError::TargetGone { id } => {
                        HaltReason::TargetGone { id }
                    }
                })
            }
            _ => Ok(()),
        }
    }

    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Vec<EventPayload> {
        let Validated::Recruit { target, bait, .. } = validated else {
            return Vec::new();
        };
        let bonus = bonus_of(*bait).expect("the bait was validated before the debit");
        let (cur_hp, max_hp) = state
            .unit(*target)
            .map(|w| (w.cur_hp, w.max_hp()))
            .expect("the recruit target exists");
        let event = resolve_recruit(state, unit, *target, bonus)
            .expect("the preflight passed, so the roll resolves");
        self.attempts.push(Attempt {
            cur_hp,
            max_hp,
            hp_permille: u32::from(cur_hp) * 1000 / u32::from(max_hp),
            pct: event.pct,
            expected_pct: recruit_odds(max_hp, cur_hp, bonus)
                .expect("the bait is in range")
                .pct,
            success: event.success,
        });
        vec![EventPayload::RecruitResult(event)]
    }
}

// ===========================================================================
// The player policy
// ===========================================================================

/// The recruit cell's no-overkill rule: a Heavy aimed at a wild under half HP becomes the Light
/// when the Light can hit the same target from the tile the plan leaves the unit on.
fn no_overkill(state: &TacticalState, actor_id: u32, plan: Vec<QueuedAction>) -> Vec<QueuedAction> {
    let actor = state.unit(actor_id).expect("the acting unit exists");
    let Some(light) = actor.kit.skills.iter().find(|s| s.tier == Tier::Light) else {
        return plan;
    };
    let Some(heavy) = actor.kit.skills.iter().find(|s| s.tier == Tier::Heavy) else {
        return plan;
    };
    let tile = plan
        .iter()
        .rev()
        .find_map(|a| match a {
            QueuedAction::Move(m) => Some(m.dest()),
            _ => None,
        })
        .unwrap_or(actor.pos);
    let mut board = state.board();
    if let Some(me) = board.units.iter_mut().find(|u| u.id == actor_id) {
        me.pos = tile;
    }
    plan.into_iter()
        .map(|entry| {
            let QueuedAction::Skill(s) = entry else {
                return entry;
            };
            if s.skill_id != heavy.skill_id {
                return entry;
            }
            let ActionTarget::Unit(target_id) = s.target else {
                return entry;
            };
            let Some(target) = state.unit(target_id) else {
                return entry;
            };
            let weak = target.side != actor.side
                && u32::from(target.cur_hp) * 2 < u32::from(target.max_hp());
            let light_hits = target_set(&light.geometry, actor_id, target.pos, &board)
                .is_ok_and(|ids| ids.contains(&target_id));
            if weak && light_hits {
                QueuedAction::Skill(SkillAction {
                    skill_id: light.skill_id,
                    target: s.target,
                })
            } else {
                entry
            }
        })
        .collect()
}

/// What side A submits for `unit`: the bt-4 planner in `Stance::Aggressive` (side-agnostic and
/// seed-free), with the recruit cell's overrides checked first.
fn player_entries(c: &Content, case: Case, state: &TacticalState, unit: u32) -> Vec<QueuedAction> {
    let actor = state.unit(unit).expect("the waiting unit exists");
    if case.scenario.recruit {
        let weakened = state.units.iter().find(|w| {
            w.side == Side::B
                && w.is_conscious()
                && is_adjacent(actor.pos, w.pos)
                && u32::from(w.cur_hp) * 1000 / u32::from(w.max_hp()) < RECRUIT_BELOW_PERMILLE
        });
        if let Some(wild) = weakened {
            return vec![QueuedAction::Recruit(RecruitAction {
                target: wild.id,
                bait: Some(BAIT_ID),
            })];
        }
    }
    let spawn = c.map(case.scenario.map_id).map.spawn_a[usize::from(actor.slot)];
    let plan = ai_plan(state, unit, Stance::Aggressive, spawn, &c.tuning);
    if case.scenario.recruit {
        no_overkill(state, unit, plan)
    } else {
        plan
    }
}

// ===========================================================================
// The driver
// ===========================================================================

/// Everything a fight produced that the gate or the report reads.
#[derive(Clone, Debug, PartialEq)]
struct FightReport {
    seed: u64,
    outcome: BattleOutcome,
    rounds: u16,
    unit_turns: u32,
    /// Final `cur_hp` of every unit in `(side, slot)` order.
    final_hp: Vec<u16>,
    a_attacks: u32,
    b_attacks: u32,
    b_kos: u32,
    /// Total HP side A lost over the fight.
    a_hp_lost: u32,
    attempts: Vec<Attempt>,
    ended_by_recruit: bool,
    halts: u32,
    non_neutral_hits: u32,
}

fn absorb(events: &mut Vec<EventPayload>, final_step_has_round_end: &mut bool, step: StepResult) {
    *final_step_has_round_end = step
        .events
        .iter()
        .any(|e| matches!(e, EventPayload::RoundEnded(_)));
    events.extend(step.events);
}

fn simulate(c: &Content, case: Case, seed: u64) -> FightReport {
    let map = &c.map(case.scenario.map_id).map;
    let (player_aff, player_skill) = case.mix.player();
    let (wild_aff, wild_skill) = WILD_AFFINITIES;
    let player_kit = c.unit_kit(player_aff, player_skill);
    let wild_kit = c.unit_kit(wild_aff, wild_skill);
    let hp = c.stats.hp;

    let mut units = Vec::new();
    let mut wilds = Vec::new();
    for i in 0..case.scenario.per_side {
        let slot = u8::try_from(i).expect("a slot");
        let wild_id = WILD_BASE + u32::from(slot) + 1;
        units.push(
            deploy_unit(
                u32::from(slot) + 1,
                Side::A,
                slot,
                map.spawn_a[i],
                player_kit.clone(),
                hp,
            )
            .expect("a player unit deploys"),
        );
        units.push(
            deploy_unit(wild_id, Side::B, slot, map.spawn_b[i], wild_kit.clone(), hp)
                .expect("a wild unit deploys"),
        );
        wilds.push((wild_id, c.kit.stance, map.spawn_b[i]));
    }
    let state = TacticalState::new(BattleKind::Wild, seed, map, units).expect("the board is legal");
    let mut battle = TacticalBattle::new(1, state);
    let mut hooks = PacingHooks {
        tuning: &c.tuning,
        wilds,
        bait_stock: BAIT_STOCK,
        attempts: Vec::new(),
    };
    let rules = Rules {
        chart: &c.chart,
        tuning: &c.tuning,
    };

    let mut events: Vec<EventPayload> = Vec::new();
    let mut final_step_has_round_end = false;
    let mut advances = 0u32;
    let mut inputs = 0u32;
    let mut now: i64 = 1_000_000;

    let step = battle
        .start(now, &rules, &mut hooks)
        .unwrap_or_else(|e| panic!("seed {seed}: start refused: {e:?}"));
    absorb(&mut events, &mut final_step_has_round_end, step);
    while battle.phase() != Phase::Finished {
        inputs += 1;
        assert!(
            inputs <= INPUT_CAP && battle.state.round <= ROUND_CAP,
            "seed {seed}: {} {:?} did not finish within the caps (input {inputs}, round {})",
            case.scenario.name,
            case.mix,
            battle.state.round
        );
        now += TICK_MS;
        match battle.turn_state {
            TurnState::Waiting(unit) => {
                let side = battle.state.unit(unit).map(|u| u.side);
                assert_eq!(
                    side,
                    Some(Side::A),
                    "seed {seed}: only the player side waits, but unit {unit} did"
                );
                let entries = player_entries(c, case, &battle.state, unit);
                let step = battle
                    .submit_queue(now, Side::A, unit, entries.clone(), &rules, &mut hooks)
                    .unwrap_or_else(|e| {
                        panic!(
                            "seed {seed}: the policy submitted an illegal plan {entries:?} for \
                             unit {unit}: {e:?}"
                        )
                    });
                absorb(&mut events, &mut final_step_has_round_end, step);
            }
            TurnState::Advancing => {
                let pin = battle.advance_pin().expect("Advancing carries a pin");
                let step = battle
                    .advance(now, pin, &rules, &mut hooks)
                    .unwrap_or_else(|e| panic!("seed {seed}: advance refused: {e:?}"));
                advances += 1;
                absorb(&mut events, &mut final_step_has_round_end, step);
            }
            TurnState::NotActive => {
                panic!("seed {seed}: an unfinished battle is NotActive")
            }
        }
    }

    let state = &battle.state;
    let a_alive = state
        .units
        .iter()
        .any(|u| u.side == Side::A && u.is_conscious());
    let b_alive = state
        .units
        .iter()
        .any(|u| u.side == Side::B && u.is_conscious());
    match state.outcome {
        BattleOutcome::SideAWins => assert!(
            a_alive && !b_alive,
            "seed {seed}: SideAWins but the wild side still has a conscious unit"
        ),
        BattleOutcome::SideBWins => assert!(
            !a_alive,
            "seed {seed}: SideBWins but the player side still has a conscious unit"
        ),
        other => panic!(
            "seed {seed}: {} {:?} ended {other:?}, not by elimination or recruit",
            case.scenario.name, case.mix
        ),
    }

    let mut a_attacks = 0u32;
    let mut b_attacks = 0u32;
    let mut b_kos = 0u32;
    let mut turn_ended = 0u32;
    let mut round_ended = 0u32;
    let mut halts = 0u32;
    let mut non_neutral_hits = 0u32;
    for event in &events {
        match event {
            EventPayload::Executed(x) => {
                if x.attacker > WILD_BASE {
                    b_attacks += 1;
                } else {
                    a_attacks += 1;
                }
                non_neutral_hits += x
                    .results
                    .iter()
                    .filter(|r| r.hit && r.effectiveness != Some(HitEffectiveness::Neutral))
                    .map(|_| 1u32)
                    .sum::<u32>();
            }
            EventPayload::Ko(k) if k.unit > WILD_BASE => b_kos += 1,
            EventPayload::TurnEnded(_) => turn_ended += 1,
            EventPayload::RoundEnded(_) => round_ended += 1,
            EventPayload::PlanHalted(_) => halts += 1,
            _ => {}
        }
    }

    // Rounds cross-check: 1 + the boundaries crossed. A fight the upkeep itself decided emits its
    // `RoundEnded` in the final step and crosses nothing.
    let boundaries = round_ended - u32::from(final_step_has_round_end);
    assert_eq!(
        u32::from(state.round),
        1 + boundaries,
        "seed {seed}: the final round is 1 + the RoundEnded events of the rounds that were left"
    );
    assert_eq!(
        advances, boundaries,
        "seed {seed}: one advance per crossed boundary"
    );

    FightReport {
        seed,
        outcome: state.outcome,
        rounds: state.round,
        unit_turns: turn_ended + u32::from(!final_step_has_round_end),
        final_hp: state.units.iter().map(|u| u.cur_hp).collect(),
        a_attacks,
        b_attacks,
        b_kos,
        a_hp_lost: state
            .units
            .iter()
            .filter(|u| u.side == Side::A)
            .map(|u| u32::from(u.max_hp() - u.cur_hp))
            .sum(),
        attempts: hooks.attempts,
        ended_by_recruit: state.outcome == BattleOutcome::SideAWins
            && state
                .units
                .iter()
                .any(|u| u.side == Side::B && u.state == UnitState::Recruited),
        halts,
        non_neutral_hits,
    }
}

fn run_cell(c: &Content, case: Case) -> Vec<FightReport> {
    SEEDS.map(|seed| simulate(c, case, seed)).collect()
}

// ===========================================================================
// Per-cell assertions + report
// ===========================================================================

fn median<T: Copy>(sorted: &[T]) -> T {
    sorted[sorted.len() / 2]
}

fn p90<T: Copy>(sorted: &[T]) -> T {
    sorted[sorted.len() * 9 / 10]
}

/// The totals the cross-cell test compares.
struct CellSummary {
    median_rounds: u16,
    player_attacks: u64,
    wild_kos: u64,
}

fn summarise(reports: &[FightReport]) -> CellSummary {
    let mut rounds: Vec<u16> = reports.iter().map(|r| r.rounds).collect();
    rounds.sort_unstable();
    CellSummary {
        median_rounds: median(&rounds),
        player_attacks: reports.iter().map(|r| u64::from(r.a_attacks)).sum(),
        wild_kos: reports.iter().map(|r| u64::from(r.b_kos)).sum(),
    }
}

fn check_cell(case: Case) -> Vec<FightReport> {
    let c = content();
    let sc = case.scenario;
    let label = format!("{} / {:?}", sc.name, case.mix);
    assert_preconditions(c, case);
    let reports = run_cell(c, case);
    let n = reports.len();
    assert_eq!(n, SEEDS.clone().count(), "{label}: one report per seed");

    // 1. Every fight decided cleanly (simulate panics otherwise); the planner's plans all pop.
    for r in &reports {
        assert_eq!(
            r.halts, 0,
            "{label} seed {}: a plan was halted at pop (the planner emits only gate-valid plans)",
            r.seed
        );
        assert_eq!(
            r.non_neutral_hits, 0,
            "{label} seed {}: every hit is neutral (STAB is the only lever)",
            r.seed
        );
    }

    // 2. Pacing.
    let mut rounds: Vec<u16> = reports.iter().map(|r| r.rounds).collect();
    rounds.sort_unstable();
    let (med, p90_rounds, max, min) = (
        median(&rounds),
        p90(&rounds),
        *rounds.last().expect("rounds"),
        rounds[0],
    );
    assert!(
        med <= sc.bound,
        "{label}: median rounds {med} exceeds the bound {} (p90 {p90_rounds}, max {max}, min {min}, \
         rounds {rounds:?})",
        sc.bound
    );
    assert!(
        p90_rounds <= 2 * sc.bound,
        "{label}: p90 rounds {p90_rounds} exceeds twice the bound {} — a stalling minority \
         (rounds {rounds:?})",
        sc.bound
    );
    assert!(
        min >= 2,
        "{label}: a fight ended in round {min}; contact at distance >= 4 cannot decide round 1"
    );

    // 3. Unit-turns.
    let mut turns: Vec<u32> = reports.iter().map(|r| r.unit_turns).collect();
    turns.sort_unstable();
    let med_turns = median(&turns);

    // 4. Non-vacuity.
    let mut fingerprints: Vec<(u16, Vec<u16>)> = reports
        .iter()
        .map(|r| (r.rounds, r.final_hp.clone()))
        .collect();
    fingerprints.sort();
    fingerprints.dedup();
    assert!(
        fingerprints.len() >= 3,
        "{label}: only {} distinct fight fingerprints over {n} seeds — the seed is not driving the fight",
        fingerprints.len()
    );
    let wild_fought = reports.iter().filter(|r| r.b_attacks >= 1).count();
    assert!(
        wild_fought * 4 >= n * 3,
        "{label}: the wild attacked in only {wild_fought} of {n} fights (want >= 75%) — the AI is inert"
    );
    let lost: u32 = reports.iter().map(|r| r.a_hp_lost).sum();
    assert!(lost > 0, "{label}: side A lost no HP in any fight");

    // 5. The recruit path.
    let attempts: Vec<&Attempt> = reports.iter().flat_map(|r| r.attempts.iter()).collect();
    let successes = attempts.iter().filter(|a| a.success).count();
    if sc.recruit {
        assert!(
            reports
                .iter()
                .any(|r| r.attempts.iter().any(|a| !a.success)),
            "{label}: no seed had a failed recruit attempt"
        );
        assert!(
            reports.iter().any(|r| r.attempts.iter().any(|a| a.success)),
            "{label}: no seed had a successful recruit attempt"
        );
        let by_recruit = reports.iter().filter(|r| r.ended_by_recruit).count();
        assert!(
            by_recruit * 4 >= n,
            "{label}: only {by_recruit} of {n} fights ended by recruit (want >= 25%)"
        );
        for a in &attempts {
            assert!(
                a.hp_permille < RECRUIT_BELOW_PERMILLE,
                "{label}: an attempt at {} / {} HP ({} per mille) is not below a quarter",
                a.cur_hp,
                a.max_hp,
                a.hp_permille
            );
            assert_eq!(
                a.pct, a.expected_pct,
                "{label}: the roll's pct is recruit_odds(max, hp, 150).pct at {} / {} HP",
                a.cur_hp, a.max_hp
            );
        }
    } else {
        assert!(
            attempts.is_empty() && reports.iter().all(|r| !r.ended_by_recruit),
            "{label}: a kill cell never recruits"
        );
    }

    // 6. Determinism: the same (case, seed) twice gives the identical report.
    for seed in 1..=4u64 {
        let again = simulate(c, case, seed);
        let first = &reports[usize::try_from(seed - 1).expect("a small index")];
        assert_eq!(
            &again, first,
            "{label} seed {seed}: re-simulating gave a different fight"
        );
    }

    let wins = reports
        .iter()
        .filter(|r| r.outcome == BattleOutcome::SideAWins)
        .count();
    println!(
        "bt13 pacing | {label} | level {} hp {} | rounds median {med} p90 {p90_rounds} max {max} \
         (bound {}) | unit-turns median {med_turns} | player wins {wins}/{n} | recruit attempts {} \
         success {}/{}",
        c.level,
        c.stats.hp,
        sc.bound,
        attempts.len(),
        successes,
        attempts.len()
    );
    reports
}

// ===========================================================================
// The cells
// ===========================================================================

#[test]
fn wild_1v1_on_7x7_stays_within_the_round_budget_without_stab_bt13_1() {
    check_cell(Case {
        scenario: ONE_V_ONE,
        mix: Mix::NoStab,
    });
}

#[test]
fn wild_1v1_on_7x7_stays_within_the_round_budget_with_stab_bt13_1() {
    check_cell(Case {
        scenario: ONE_V_ONE,
        mix: Mix::Stab,
    });
}

#[test]
fn wild_1v1_recruit_path_on_7x7_stays_within_the_round_budget_without_stab_bt13_1() {
    check_cell(Case {
        scenario: RECRUIT,
        mix: Mix::NoStab,
    });
}

#[test]
fn wild_1v1_recruit_path_on_7x7_stays_within_the_round_budget_with_stab_bt13_1() {
    check_cell(Case {
        scenario: RECRUIT,
        mix: Mix::Stab,
    });
}

#[test]
fn wild_3v3_on_8x8_stays_within_the_round_budget_without_stab_bt13_1() {
    check_cell(Case {
        scenario: THREE_V_THREE,
        mix: Mix::NoStab,
    });
}

#[test]
fn wild_3v3_on_8x8_stays_within_the_round_budget_with_stab_bt13_1() {
    check_cell(Case {
        scenario: THREE_V_THREE,
        mix: Mix::Stab,
    });
}

/// STAB is a player-side bonus only: per scenario the STAB mix is never slower than the no-STAB
/// mix (median rounds), and in the 1v1 cell the player needs strictly fewer attack actions per
/// wild KO — a neutered STAB multiplier leaves the two mixes identical and fails the strict half.
#[test]
fn stab_never_slows_a_scenario_and_speeds_up_the_1v1_kill_bt13_1() {
    let c = content();
    for scenario in [ONE_V_ONE, RECRUIT, THREE_V_THREE] {
        let plain_case = Case {
            scenario,
            mix: Mix::NoStab,
        };
        let stab_case = Case {
            scenario,
            mix: Mix::Stab,
        };
        assert_preconditions(c, plain_case);
        assert_preconditions(c, stab_case);
        let plain = summarise(&run_cell(c, plain_case));
        let stab = summarise(&run_cell(c, stab_case));
        println!(
            "bt13 stab | {} | median rounds no-STAB {} vs STAB {} | player attacks / wild KOs: \
             no-STAB {}/{} vs STAB {}/{}",
            scenario.name,
            plain.median_rounds,
            stab.median_rounds,
            plain.player_attacks,
            plain.wild_kos,
            stab.player_attacks,
            stab.wild_kos
        );
        assert!(
            stab.median_rounds <= plain.median_rounds,
            "{}: STAB median rounds {} exceed the no-STAB median {}",
            scenario.name,
            stab.median_rounds,
            plain.median_rounds
        );
        if scenario.name == ONE_V_ONE.name {
            assert!(
                plain.wild_kos > 0 && stab.wild_kos > 0,
                "{}: both mixes must KO a wild for the per-KO comparison to mean anything",
                scenario.name
            );
            // attacks/KO strictly lower under STAB: stab.attacks / stab.kos < plain.attacks / plain.kos.
            assert!(
                stab.player_attacks * plain.wild_kos < plain.player_attacks * stab.wild_kos,
                "{}: STAB needs {}/{} attack actions per wild KO, no-STAB {}/{} — STAB must be strictly cheaper",
                scenario.name,
                stab.player_attacks,
                stab.wild_kos,
                plain.player_attacks,
                plain.wild_kos
            );
        }
    }
}
