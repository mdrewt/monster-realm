//! bt-9 gating tests for the tactical settlement (spec M-battle-tactics BT9.1–BT9.7).
//!
//! Two layers:
//! - the PURE core of `tactics_settle.rs` (`ledger_of`, `board_at`, `awards_events`,
//!   `step_delta`, `apply_delta`) over boards and transcripts built here, with game-core's own
//!   rules as the oracle (`rewards::on_unit_defeated` / `pay`, `resolve_attack`, `run_upkeep`);
//! - the SHELL, driven through the shipped reducers of `tactics.rs` on bt-8's `tactics_tests`
//!   world: every terminal path, the recruit glue, the faint penalty, the prior-terminal sweep,
//!   the summary row and the playtest row.
//!
//! Rolls are made deterministic the way the brief prescribes: the accuracy roll and the recruit
//! roll are both `splitmix64(battle_secret.seed ^ action_seq) % 100`, so a test rewrites the
//! `battle_secret` row (keeping `action_seq`) to the first seed whose next draw does what the
//! test needs — `load` hydrates the engine from that row, so the edit is authoritative.

use std::collections::BTreeSet;

use super::{
    apply_delta, awards_events, board_at, ledger_of, step_delta, StepDelta, StepPrev,
    CURRENCY_AWARD_UNIT, WEAKEN_FIRST_PERMILLE,
};
use crate::marshal::{monster_from_instance, pub_from_monster};
use crate::native_host_tests::{fixture, Fixture};
use crate::playtest::{build_playtest_event, hp_permille, PlaytestEvent};
use crate::schema::{
    Battle, BattleClock, BattleEvent, BattleSecret, BattleSummary, BattleTactical, BattleUnit,
    BattleWildUnit, Inventory, Monster, MoveClassRow, SideRow, SpeciesRow,
};
use crate::tactics::tactics_tests::{
    a, advance_args, at, b, changed, deadline_args, deploy, deploying_pair, enc, fire_advance,
    fire_deadline, legacy_lost_anchor, light, live_pair, loaded, map_def, none, offer,
    party_monster, pick, rest, seat_in_light_range, seed_for, species_def, start, submit, time,
    world, Live, World, DAY_MS, PAIR, PVE_WINDOW_MS, QUAD, T0,
};
use crate::tactics::{BattleGcSched, TacticalAdvanceSched, TacticalDeadlineSched};
use game_core::currency::essence_battle_reward;
use game_core::tactics::{
    build_kits, deploy_unit, load_tactics_skills, load_tactics_species, load_tactics_tuning,
    on_unit_defeated, pay, payload_of, recruit_odds, resolve_attack, run_upkeep, splitmix64,
    turn_start, AutoPassEvent, Award, AwardsEvent, BattleEndEvent, BattleKind, BattleStartedEvent,
    Cell, Credit, EndHow, EventPayload, ExecutedEvent, HaltKind, HitEffectiveness, ItemUsedEvent,
    KoEvent, Ledger, MissedEvent, MoveClass, Payout, Phase, PlanHaltedEvent, QueuedAction,
    RecruitAction, RecruitResultEvent, Side, SkillTactics, SpeciesTactics, StatusChange,
    StatusEvent, StepResult, SurgeEvent, TacticalEvent, TacticalState, TacticalUnit, TargetHit,
    TurnEndedEvent, TurnState, UnitKit, UnitState,
};
use game_core::{
    apply_xp_gain, base_stat_total, battle_currency_reward, battle_xp_reward, Affinity,
    BattleMonster, BattleOutcome, BattleSide, BattleState, Level, StatBlock, StatusEffect,
    TradeItem, TypeChart, Xp,
};
use spacetimedb::Identity;

// ===========================================================================
// Content + arithmetic oracles (game-core is the rule SSOT)
// ===========================================================================

/// The stat block of every hand-built unit in the pure tests.
const STATS: StatBlock = StatBlock {
    hp: 100,
    attack: 60,
    defense: 60,
    speed: 50,
    sp_attack: 60,
    sp_defense: 60,
};

/// The eight essence pools, in the `monster` row's column order.
const AFFINITIES: [Affinity; 8] = [
    Affinity::Fire,
    Affinity::Water,
    Affinity::Plant,
    Affinity::Electric,
    Affinity::Earth,
    Affinity::Wind,
    Affinity::Light,
    Affinity::Dark,
];

fn level(n: u8) -> Level {
    Level::new(n).expect("a fixture level is a level")
}

/// The species' base-stat total (what every reward rule reads).
fn bst(species_id: u32) -> u16 {
    base_stat_total(&species_def(species_id).base_stats)
}

/// The content lookup `ledger_of` is handed: `None` for a species not in content.
fn bst_of(species_id: u32) -> Option<u16> {
    game_core::load_species()
        .expect("species content loads")
        .into_iter()
        .find(|s| s.id == species_id)
        .map(|s| base_stat_total(&s.base_stats))
}

fn affinity_of(species_id: u32) -> Affinity {
    species_def(species_id).affinity
}

fn accuracy_of(skill_id: u32) -> u8 {
    game_core::load_skills()
        .expect("skill content loads")
        .into_iter()
        .find(|s| s.id == skill_id)
        .map(|s| s.accuracy)
        .unwrap_or_else(|| panic!("skill {skill_id} is in the content"))
}

fn bait_bonus(item_id: u32) -> u16 {
    game_core::load_items()
        .expect("item content loads")
        .into_iter()
        .find(|i| i.id == item_id)
        .map(|i| i.recruit_bonus)
        .unwrap_or_else(|| panic!("item {item_id} is in the content"))
}

fn pool(m: &Monster, affinity: Affinity) -> u32 {
    match affinity {
        Affinity::Fire => m.essence_fire,
        Affinity::Water => m.essence_water,
        Affinity::Plant => m.essence_plant,
        Affinity::Electric => m.essence_electric,
        Affinity::Earth => m.essence_earth,
        Affinity::Wind => m.essence_wind,
        Affinity::Light => m.essence_light,
        Affinity::Dark => m.essence_dark,
    }
}

fn pools(m: &Monster) -> [u32; 8] {
    AFFINITIES.map(|affinity| pool(m, affinity))
}

/// `(xp, level)` after gaining `gained` XP, by the carried rule.
fn after_gain(xp: u32, gained: u32) -> (u32, u8) {
    let (xp, level, _) = apply_xp_gain(Xp::new(xp), Xp::new(gained));
    (xp.value(), level.as_u8())
}

// ===========================================================================
// Pure boards + transcripts
// ===========================================================================

/// `(id, side, slot, species, level, x, y)` of one unit on the 8x8 open field (map 4).
type Seat = (u32, Side, u8, u32, u8, u8, u8);

/// A skill-less battler: the fold tests never resolve an attack. A species missing from content
/// (999) gets a placeholder affinity — the point of that unit is its missing BST.
fn plain_kit(species_id: u32, level: u8) -> UnitKit {
    let affinity = game_core::load_species()
        .expect("species content loads")
        .into_iter()
        .find(|s| s.id == species_id)
        .map_or(Affinity::Fire, |s| s.affinity);
    UnitKit {
        species_id,
        affinity,
        level,
        stats: STATS,
        base_speed: 50,
        class: MoveClass::Walk,
        skills: Vec::new(),
    }
}

fn content_kits() -> Vec<SpeciesTactics> {
    build_kits(
        &game_core::load_species().expect("species content loads"),
        &game_core::load_skills().expect("skill content loads"),
        &load_tactics_skills().expect("tactics skill content loads"),
        &load_tactics_species().expect("tactics species content loads"),
    )
    .expect("the shipped kits join")
}

/// The species' shipped kit with both skills made sure-hit (accuracy 100), so the live
/// reference's KOs are not left to a roll.
fn real_kit(kits: &[SpeciesTactics], species_id: u32, level: u8) -> UnitKit {
    let kit = kits
        .iter()
        .find(|k| k.species_id == species_id)
        .unwrap_or_else(|| panic!("species {species_id} has a kit"));
    let sure = |s: &SkillTactics| SkillTactics {
        accuracy: 100,
        ..s.clone()
    };
    UnitKit {
        species_id,
        affinity: affinity_of(species_id),
        level,
        stats: STATS,
        base_speed: kit.base_speed,
        class: kit.movement,
        skills: vec![sure(&kit.light), sure(&kit.heavy)],
    }
}

fn board(seats: &[Seat], kit: impl Fn(u32, u8) -> UnitKit) -> TacticalState {
    let units: Vec<TacticalUnit> = seats
        .iter()
        .map(|&(id, side, slot, species, lvl, x, y)| {
            deploy_unit(id, side, slot, Cell { x, y }, kit(species, lvl), STATS.hp)
                .expect("a fixture unit deploys")
        })
        .collect();
    TacticalState::new(BattleKind::Wild, 0x5EED, &map_def(4), units)
        .expect("the fixture board is legal")
}

/// The unit as the KO sweep leaves it.
fn fall(state: &mut TacticalState, id: u32) {
    if let Some(u) = state.unit_mut(id) {
        u.cur_hp = 0;
        u.state = UnitState::Fainted;
    }
    state.remove_from_initiative(id);
}

fn unit_pos(state: &TacticalState, id: u32) -> Cell {
    state
        .unit(id)
        .map(|u| u.pos)
        .unwrap_or_else(|| panic!("unit {id} is on the board"))
}

fn target_hit(unit: u32, damage: u16, ko: bool, effectiveness: HitEffectiveness) -> TargetHit {
    TargetHit {
        unit,
        hit: true,
        damage,
        effectiveness: Some(effectiveness),
        flank: false,
        guard: false,
        ko,
    }
}

fn target_miss(unit: u32) -> TargetHit {
    TargetHit {
        unit,
        hit: false,
        damage: 0,
        effectiveness: None,
        flank: false,
        guard: false,
        ko: false,
    }
}

fn executed(attacker: u32, results: Vec<TargetHit>) -> EventPayload {
    EventPayload::Executed(ExecutedEvent {
        attacker,
        skill_id: 1,
        results,
    })
}

/// One neutral single-target hit.
fn hit(attacker: u32, unit: u32, damage: u16, ko: bool) -> EventPayload {
    executed(
        attacker,
        vec![target_hit(unit, damage, ko, HitEffectiveness::Neutral)],
    )
}

fn ko(unit: u32) -> EventPayload {
    EventPayload::Ko(KoEvent { unit })
}

fn tick(unit: u32) -> EventPayload {
    EventPayload::Status(StatusEvent {
        unit,
        status: StatusEffect::Poison,
        change: StatusChange::Tick,
        amount: 12,
    })
}

fn battle_end(outcome: BattleOutcome) -> EventPayload {
    EventPayload::BattleEnd(BattleEndEvent {
        outcome,
        how: EndHow::SideEmpty,
    })
}

/// The live reference: append `events` to the transcript and, at every `Ko` among them, credit
/// the victim's last opposite-side hitter against the board AS IT STANDS RIGHT NOW (never a
/// reconstruction) — what the shell would do if it could watch every KO happen.
fn live_step(
    state: &TacticalState,
    events: &[TacticalEvent],
    transcript: &mut Vec<EventPayload>,
    live: &mut Ledger,
    last: &mut Vec<(u32, u32)>,
) {
    for event in events {
        transcript.push(payload_of(event));
        match event {
            TacticalEvent::Executed {
                attacker, results, ..
            } => {
                let side = state.unit(*attacker).map(|u| u.side);
                for r in results {
                    let opposite = state.unit(r.unit).map(|u| u.side) != side;
                    if r.hit && (r.damage > 0 || r.ko) && opposite {
                        last.retain(|(victim, _)| *victim != r.unit);
                        last.push((r.unit, *attacker));
                    }
                }
            }
            TacticalEvent::Ko { unit } => {
                if let Some(&(_, killer)) = last.iter().find(|(victim, _)| victim == unit) {
                    let species = state
                        .unit(*unit)
                        .map(|u| u.kit.species_id)
                        .expect("the victim is on the board");
                    on_unit_defeated(live, state, killer, *unit, bst(species))
                        .expect("the live KO is a valid KO");
                }
            }
            _ => {}
        }
    }
}

// ===========================================================================
// BT9.1 — the ledger fold (pure)
// ===========================================================================

/// Design §7: one attack KO pays the killer `total − n·⌊total/2/n⌋`, each conscious side-mate
/// `⌊total/2/n⌋`, the killer the victim's essence and the player the currency.
#[test]
fn ledger_of_credits_an_attack_ko_to_the_killer_with_the_conscious_side_mates_share_bt9_1() {
    let wild_species = 2;
    let mut fin = board(
        &[
            (1, Side::A, 0, 1, 10, 1, 1),
            (2, Side::A, 1, 3, 10, 3, 1),
            (3, Side::B, 0, wild_species, 5, 3, 3),
        ],
        plain_kit,
    );
    fall(&mut fin, 3);
    let events = vec![
        hit(1, 3, 40, true),
        ko(3),
        battle_end(BattleOutcome::SideAWins),
    ];
    let fold = ledger_of(&events, &fin, &bst_of);
    let victim_bst = bst(wild_species);
    let total = battle_xp_reward(level(10), victim_bst, level(5)).value();
    let each = total / 2;
    assert!(each > 0, "non-vacuous: the side-mate's share is not zero");
    let affinity = affinity_of(wild_species);
    assert_eq!(
        fold.ledger,
        Ledger {
            credits: vec![
                Credit {
                    unit: 1,
                    victim: 3,
                    xp: total - each,
                    essence: essence_battle_reward(victim_bst),
                    affinity,
                },
                Credit {
                    unit: 2,
                    victim: 3,
                    xp: each,
                    essence: 0,
                    affinity,
                },
            ],
            currency: battle_currency_reward(victim_bst),
        },
        "the killer, the side-mate and the player, by the design §7 split"
    );
    assert!(
        fold.unattributed.is_empty() && fold.skipped_bst.is_empty() && fold.missing_ko.is_empty(),
        "a clean transcript has no audit finding"
    );
}

/// Credits are judged against the board AT the KO: a side-mate that falls later still earned its
/// share, and `pay` then forfeits it (conscious-at-end only).
#[test]
fn ledger_of_credits_a_side_mate_that_falls_after_the_kill_and_pay_forfeits_it_bt9_1() {
    let seats: [Seat; 4] = [
        (1, Side::A, 0, 1, 10, 1, 1),
        (2, Side::A, 1, 3, 10, 3, 1),
        (3, Side::B, 0, 2, 5, 3, 3),
        (4, Side::B, 1, 1, 5, 5, 5),
    ];
    let mut fin = board(&seats, plain_kit);
    fall(&mut fin, 3);
    fall(&mut fin, 2);
    let events = vec![hit(1, 3, 40, true), ko(3), hit(4, 2, 40, true), ko(2)];
    let fold = ledger_of(&events, &fin, &bst_of);
    let mut moment = board(&seats, plain_kit);
    let mut want = Ledger::default();
    fall(&mut moment, 3);
    on_unit_defeated(&mut want, &moment, 1, 3, bst(2)).expect("u1's kill is creditable");
    fall(&mut moment, 2);
    on_unit_defeated(&mut want, &moment, 4, 2, bst(3)).expect("a wild's kill is a valid KO");
    assert_eq!(fold.ledger, want, "each KO credited against its own moment");
    assert!(
        want.credits.iter().any(|c| c.unit == 2 && c.victim == 3),
        "non-vacuous: u2 earned a share while it stood"
    );
    let paid: Vec<u32> = pay(&fold.ledger, &fin)
        .awards
        .iter()
        .map(|aw| aw.unit)
        .collect();
    assert_eq!(
        paid,
        vec![1],
        "u2's share is forfeited: it is not conscious at the end"
    );
}

/// A death by status tick goes to the victim's last OPPOSITE-side hitter; a victim only its own
/// side hit, or nobody hit, is unattributed and earns nobody anything.
#[test]
fn ledger_of_credits_a_tick_death_to_the_last_opposite_side_hitter_only_bt9_1() {
    let seats: [Seat; 5] = [
        (1, Side::A, 0, 1, 10, 1, 1),
        (2, Side::A, 1, 3, 10, 3, 1),
        (3, Side::B, 0, 2, 5, 2, 6),
        (4, Side::B, 1, 1, 5, 4, 6),
        (5, Side::B, 2, 3, 5, 6, 6),
    ];
    let mut fin = board(&seats, plain_kit);
    for id in [3, 4, 5] {
        fall(&mut fin, id);
    }
    let events = vec![
        hit(1, 3, 5, false),
        hit(3, 4, 5, false),
        tick(3),
        ko(3),
        tick(4),
        ko(4),
        tick(5),
        ko(5),
        battle_end(BattleOutcome::SideAWins),
    ];
    let fold = ledger_of(&events, &fin, &bst_of);
    let mut moment = board(&seats, plain_kit);
    fall(&mut moment, 3);
    let mut want = Ledger::default();
    on_unit_defeated(&mut want, &moment, 1, 3, bst(2)).expect("u1's tick kill is creditable");
    assert_eq!(
        fold.ledger, want,
        "only the tick death after u1's hit is credited, and to u1"
    );
    let mut unattributed = fold.unattributed.clone();
    unattributed.sort_unstable();
    assert_eq!(
        unattributed,
        vec![4, 5],
        "a same-side hit (4) and no hit at all (5) attribute nobody"
    );
}

/// A recruited wild is never a KO; a species with no content row is skipped (never a 0-BST
/// credit); a unit that ended Fainted without a `Ko` is reported, not credited.
#[test]
fn ledger_of_never_credits_a_recruit_or_an_unknown_species_and_flags_a_fall_without_a_ko_bt9_1() {
    let seats: [Seat; 5] = [
        (1, Side::A, 0, 1, 10, 1, 1),
        (2, Side::A, 1, 3, 10, 3, 1),
        (3, Side::B, 0, 2, 5, 2, 6),
        (4, Side::B, 1, 999, 5, 4, 6),
        (5, Side::B, 2, 3, 5, 6, 6),
    ];
    assert_eq!(
        bst_of(999),
        None,
        "PRECONDITION: species 999 is not in content"
    );
    let mut fin = board(&seats, plain_kit);
    if let Some(u) = fin.unit_mut(3) {
        u.state = UnitState::Recruited;
    }
    fin.remove_from_initiative(3);
    fall(&mut fin, 4);
    fall(&mut fin, 5);
    let events = vec![
        hit(1, 3, 5, false),
        EventPayload::RecruitResult(RecruitResultEvent {
            unit: 1,
            target: 3,
            success: true,
            pct: 40,
        }),
        hit(1, 4, 50, true),
        ko(4),
        hit(2, 5, 5, false),
        battle_end(BattleOutcome::SideAWins),
    ];
    let fold = ledger_of(&events, &fin, &bst_of);
    assert_eq!(
        fold.ledger,
        Ledger::default(),
        "a recruit, a BST-less species and an unrecorded fall earn nothing"
    );
    assert_eq!(
        fold.skipped_bst,
        vec![4],
        "the content-less species is reported"
    );
    assert_eq!(
        fold.missing_ko,
        vec![5],
        "the fall without a Ko is reported"
    );
    assert!(fold.unattributed.is_empty());
}

/// The differential: the fold over the transcript game-core actually emitted equals the ledger a
/// live observer would have written KO by KO — over an AoE multi-KO (skill 6, Diamond r1), a
/// killer AND a side-mate that both fall after the kill, and a poison-tick death in upkeep.
#[test]
fn ledger_of_equals_the_live_ko_by_ko_reference_over_an_aoe_multi_ko_and_later_falls_bt9_1() {
    let tuning = load_tactics_tuning().expect("tactics tuning content loads");
    let chart = TypeChart::new(&game_core::load_type_chart().expect("type chart content loads"));
    let kits = content_kits();
    // A: P1 artillery (species 3: the Diamond-r1 Heavy, skill 6), P2 ranged (species 1: skill 1
    // at 2-3), P3 (species 2). B: W1 and W2 inside the Diamond around W1, W3 outside it.
    let seats: [Seat; 6] = [
        (1, Side::A, 0, 3, 10, 3, 1),
        (2, Side::A, 1, 1, 10, 4, 1),
        (3, Side::A, 2, 2, 10, 5, 2),
        (4, Side::B, 0, 2, 5, 3, 4),
        (5, Side::B, 1, 3, 5, 2, 4),
        (6, Side::B, 2, 1, 5, 4, 3),
    ];
    let mut state = board(&seats, |species, lvl| real_kit(&kits, species, lvl));
    for id in [4, 5] {
        if let Some(u) = state.unit_mut(id) {
            u.cur_hp = 1;
            u.first_stand = false;
        }
    }
    let mut transcript = Vec::new();
    let mut live = Ledger::default();
    let mut last = Vec::new();

    // 1. P1's Heavy on W1: the Diamond KOs W1 and W2 in one attack.
    turn_start(&mut state, 1, &tuning).expect("P1 acts");
    let aim = unit_pos(&state, 4);
    let out =
        resolve_attack(&mut state, 1, 6, aim, &chart, &tuning).expect("the Diamond Heavy resolves");
    live_step(&state, &out.events, &mut transcript, &mut live, &mut last);
    // 2. W3 KOs P1 (the killer of W1 and W2) and P3 (their side-mate) with two Lights.
    for id in [1, 3] {
        if let Some(u) = state.unit_mut(id) {
            u.cur_hp = 1;
            u.first_stand = false;
        }
    }
    turn_start(&mut state, 6, &tuning).expect("W3 acts");
    for target in [1, 3] {
        let aim = unit_pos(&state, target);
        let out =
            resolve_attack(&mut state, 6, 1, aim, &chart, &tuning).expect("W3's Light resolves");
        live_step(&state, &out.events, &mut transcript, &mut live, &mut last);
    }
    // 3. P2 hits W3, which then dies to a poison tick in upkeep (P2 is its last hitter).
    turn_start(&mut state, 2, &tuning).expect("P2 acts");
    let aim = unit_pos(&state, 6);
    let out = resolve_attack(&mut state, 2, 1, aim, &chart, &tuning).expect("P2's Light resolves");
    live_step(&state, &out.events, &mut transcript, &mut live, &mut last);
    if let Some(u) = state.unit_mut(6) {
        u.cur_hp = 1;
        u.status = Some(StatusEffect::Poison);
    }
    let upkeep = run_upkeep(&mut state, &tuning);
    live_step(&state, &upkeep, &mut transcript, &mut live, &mut last);
    assert_eq!(
        state.outcome,
        BattleOutcome::SideAWins,
        "PRECONDITION: the tick emptied side B"
    );

    let fold = ledger_of(&transcript, &state, &bst_of);
    assert_eq!(
        fold.ledger, live,
        "the transcript fold equals the live KO-by-KO ledger"
    );
    let killer_of = |victim: u32| {
        live.credits
            .iter()
            .find(|c| c.victim == victim && c.essence > 0)
            .map(|c| c.unit)
    };
    assert_eq!(
        (killer_of(4), killer_of(5), killer_of(6)),
        (Some(1), Some(1), Some(2)),
        "non-vacuous: the AoE double KO is P1's, the tick death P2's"
    );
    assert!(
        live.credits
            .iter()
            .any(|c| c.unit == 3 && c.victim == 4 && c.xp > 0),
        "non-vacuous: P3 earned a share of the AoE kill while it stood"
    );
    for id in [1, 3] {
        assert_eq!(
            state.unit(id).map(|u| u.state),
            Some(UnitState::Fainted),
            "PRECONDITION: unit {id} fell after the kills"
        );
    }
    let paid: Vec<u32> = pay(&fold.ledger, &state)
        .awards
        .iter()
        .map(|aw| aw.unit)
        .collect();
    assert_eq!(
        paid,
        vec![2],
        "only P2 is conscious at the end: P1's and P3's credits are forfeited"
    );
    assert!(
        fold.unattributed.is_empty() && fold.skipped_bst.is_empty() && fold.missing_ko.is_empty()
    );
}

#[test]
fn board_at_restores_every_unit_not_yet_fallen_and_keeps_the_fallen_as_they_ended_bt9_1() {
    let seats: [Seat; 4] = [
        (1, Side::A, 0, 1, 10, 1, 1),
        (2, Side::A, 1, 3, 10, 3, 1),
        (3, Side::B, 0, 2, 5, 2, 6),
        (4, Side::B, 1, 1, 5, 4, 6),
    ];
    let mut fin = board(&seats, plain_kit);
    if let Some(u) = fin.unit_mut(1) {
        u.cur_hp = 37;
    }
    fall(&mut fin, 2);
    fall(&mut fin, 3);
    if let Some(u) = fin.unit_mut(4) {
        u.state = UnitState::Recruited;
    }
    let fallen: BTreeSet<u32> = [3, 4].into_iter().collect();
    let got = board_at(&fin, &fallen);
    let u2 = got.unit(2).expect("u2 is on the board");
    assert!(
        u2.is_conscious(),
        "a unit not yet fallen is restored conscious"
    );
    assert_eq!(
        (u2.state, u2.pos),
        (UnitState::Active, unit_pos(&fin, 2)),
        "restored in place"
    );
    assert_eq!(
        got.unit(1),
        fin.unit(1),
        "a unit that never fell is left exactly as it ended"
    );
    let gone = got.unit(3).expect("the fallen wild is on the board");
    assert_eq!(
        (gone.state, gone.cur_hp),
        (UnitState::Fainted, 0),
        "a fallen unit keeps its final state"
    );
    assert_eq!(
        got.unit(4).map(|u| u.state),
        Some(UnitState::Recruited),
        "a recruited unit stays recruited"
    );
}

#[test]
fn awards_events_lists_paid_monsters_ascending_with_summed_essence_and_one_currency_line_bt9_1() {
    let applied = vec![
        Award {
            unit: 3,
            xp: 10,
            essence: Vec::new(),
        },
        Award {
            unit: 7,
            xp: 30,
            essence: vec![(Affinity::Fire, 5), (Affinity::Water, 3)],
        },
    ];
    let lines: Vec<AwardsEvent> = awards_events(&applied, 12)
        .iter()
        .map(|e| match e {
            EventPayload::Awards(x) => *x,
            other => panic!("only Awards lines, got {other:?}"),
        })
        .collect();
    let per_unit: Vec<AwardsEvent> = lines
        .iter()
        .copied()
        .filter(|x| x.unit != CURRENCY_AWARD_UNIT)
        .collect();
    assert_eq!(
        per_unit,
        vec![
            AwardsEvent {
                unit: 3,
                xp: 10,
                essence: 0,
                currency: 0
            },
            AwardsEvent {
                unit: 7,
                xp: 30,
                essence: 8,
                currency: 0
            },
        ],
        "one line per credited monster, ascending, essence summed over its pools"
    );
    let currency: Vec<AwardsEvent> = lines
        .iter()
        .copied()
        .filter(|x| x.unit == CURRENCY_AWARD_UNIT)
        .collect();
    assert_eq!(
        currency,
        vec![AwardsEvent {
            unit: CURRENCY_AWARD_UNIT,
            xp: 0,
            essence: 0,
            currency: 12
        }],
        "exactly one currency line"
    );
    let no_currency = awards_events(&applied, 0);
    assert_eq!(
        no_currency.len(),
        2,
        "no currency line when none was earned"
    );
    assert!(!no_currency
        .iter()
        .any(|e| matches!(e, EventPayload::Awards(x) if x.unit == CURRENCY_AWARD_UNIT)));
    assert_eq!(
        awards_events(&[], 0),
        Vec::<EventPayload>::new(),
        "nothing applied, no line"
    );
}

// ===========================================================================
// Shell fixtures (bt-8's world + the bt-9 rows)
// ===========================================================================

/// Rewrite the battle's roll stream (keeping `action_seq`) to the first seed whose next `draws`
/// draws satisfy `want(i, value)`; `load` hydrates the engine from this row.
fn steer(w: &World<'_>, id: u64, draws: u64, want: impl Fn(u64, u64) -> bool) {
    let secret = w.secret(id);
    let seed = (1..1_000_000u64)
        .find(|&s| (0..draws).all(|i| want(i, splitmix64(s ^ secret.action_seq.wrapping_add(i)))))
        .expect("a seed steers the next draws");
    assert_eq!(
        w.secrets.remove(id),
        1,
        "battle {id}'s secret row edited in place"
    );
    w.secrets.seed(&BattleSecret {
        battle_id: id,
        seed,
        action_seq: secret.action_seq,
    });
}

/// The next attack's accuracy roll lands (`roll % 100 < accuracy`).
fn force_hit(w: &World<'_>, id: u64, skill_id: u32) {
    let accuracy = u64::from(accuracy_of(skill_id));
    steer(w, id, 1, |_, roll| roll % 100 < accuracy);
}

/// The next recruit roll (`roll % 100 < pct`) comes out `success`.
fn force_recruit(w: &World<'_>, id: u64, pct: u8, success: bool) {
    steer(w, id, 1, |_, roll| (roll % 100 < u64::from(pct)) == success);
}

/// The shown odds of recruiting `wild` as its row stands.
fn odds_pct(w: &World<'_>, wild: u32, bait: Option<u32>) -> u8 {
    let u = w.unit(wild);
    recruit_odds(u.stats.hp, u.cur_hp, bait.map_or(0, bait_bonus))
        .expect("a content bait is in range")
        .pct
}

/// Seat `target` on the tile just south of `unit` (Manhattan-adjacent).
fn seat_adjacent(w: &World<'_>, unit: u32, target: u32) {
    let from = w.unit(unit);
    w.edit_unit(target, |t| {
        t.x = from.x;
        t.y = from.y + 1;
    });
}

/// Seat the wild between `u1` (1,1) and `u2` (3,1) of map 1: adjacent to both.
fn seat_between(w: &World<'_>, live: &Live) {
    let (p, q) = (w.unit(live.u1), w.unit(live.u2));
    assert_eq!(
        (p.y, q.y, q.x, p.x + 2),
        (1, 1, q.x, q.x),
        "PRECONDITION: u1 and u2 stand two tiles apart on row 1"
    );
    w.edit_unit(live.wild, |u| {
        u.x = p.x + 1;
        u.y = p.y;
    });
}

fn recruit(target: u32, bait: Option<u32>) -> QueuedAction {
    QueuedAction::Recruit(RecruitAction { target, bait })
}

fn give(w: &World<'_>, item_id: u32, count: u32) {
    w.inventory.seed(&Inventory {
        inv_id: 500 + u64::from(item_id),
        owner_identity: a(),
        item_id,
        count,
    });
}

fn held(w: &World<'_>, item_id: u32) -> u32 {
    w.inventory
        .rows()
        .iter()
        .filter(|r| r.owner_identity == a() && r.item_id == item_id)
        .map(|r| r.count)
        .sum()
}

fn wallet(w: &World<'_>) -> u64 {
    w.wallets
        .rows()
        .iter()
        .filter(|r| r.owner_identity == a())
        .map(|r| r.balance)
        .sum()
}

fn summary_rows(w: &World<'_>, id: u64) -> Vec<BattleSummary> {
    w.summaries
        .rows()
        .into_iter()
        .filter(|s| s.battle_id == id)
        .collect()
}

fn summary(w: &World<'_>, id: u64) -> BattleSummary {
    let mut rows = summary_rows(w, id);
    assert_eq!(rows.len(), 1, "battle {id}: exactly one battle_summary row");
    rows.remove(0)
}

fn playtest_rows(w: &World<'_>, id: u64) -> Vec<PlaytestEvent> {
    let mut rows: Vec<PlaytestEvent> = w
        .playtests
        .rows()
        .into_iter()
        .filter(|e| e.battle_id == id)
        .collect();
    rows.sort_by_key(|e| e.event_id);
    rows
}

/// Every column of a playtest row but its `event_id`.
fn playtest_fields(e: &PlaytestEvent) -> (Identity, u16, i64, u64, u32, u16, u32, bool) {
    (
        e.identity,
        e.kind,
        e.created_at_ms,
        e.battle_id,
        e.species_id,
        e.hp_permille,
        e.bait_item_id,
        e.success,
    )
}

fn recruit_results(w: &World<'_>, id: u64) -> Vec<RecruitResultEvent> {
    w.events_of(id)
        .into_iter()
        .filter_map(|e| match e.payload {
            EventPayload::RecruitResult(r) => Some(r),
            _ => None,
        })
        .collect()
}

fn halts(w: &World<'_>, id: u64) -> Vec<PlanHaltedEvent> {
    w.events_of(id)
        .into_iter()
        .filter_map(|e| match e.payload {
            EventPayload::PlanHalted(h) => Some(h),
            _ => None,
        })
        .collect()
}

fn turn_ends_of(w: &World<'_>, id: u64, unit: u32) -> usize {
    w.events_of(id)
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::TurnEnded(t) if t.unit == unit))
        .count()
}

/// Monsters beyond the seeded `PAIR` (what a recruit inserts).
fn new_monsters(w: &World<'_>) -> Vec<Monster> {
    w.monsters
        .rows()
        .into_iter()
        .filter(|m| !PAIR.iter().any(|&(id, ..)| id == m.monster_id))
        .collect()
}

fn outcome(w: &World<'_>, id: u64) -> BattleOutcome {
    w.anchor(id).expect("the anchor exists").state.outcome
}

/// `unit` falls the way a KO leaves it, CONSISTENTLY: its row Fainted at 0 HP and out of the
/// initiative, the anchor's mirrored team HP at 0 (as the next `store` would write it) and a `Ko`
/// in the transcript (consciousness only ever leaves through one).
fn fall_in_battle(w: &World<'_>, id: u64, unit: u32) {
    let mid = w
        .unit(unit)
        .monster_id
        .expect("a party unit names its monster");
    w.edit_unit(unit, |u| {
        u.cur_hp = 0;
        u.state = UnitState::Fainted;
    });
    w.edit_tactical(id, |t| t.initiative.retain(|&x| x != unit));
    let mut anchor = w.anchor(id).expect("the anchor exists");
    let i = anchor
        .party_monster_ids
        .iter()
        .position(|&m| m == mid)
        .expect("the unit's monster is in the party");
    anchor.state.side_a.team[i].current_hp = 0;
    assert_eq!(w.battles.remove(id), 1, "the anchor edited in place");
    w.battles.seed(&anchor);
    let seq = w.events_of(id).last().map_or(0, |e| e.seq + 1);
    w.events.seed(&BattleEvent {
        event_id: 8_000 + u64::from(unit),
        battle_id: id,
        seq,
        round: w.tactical(id).round,
        payload: ko(unit),
    });
}

/// A pack-1 `live_pair` whose wild is about to fall: seated in u1's Light range, 1 HP,
/// First-Stand spent, and the roll stream steered so u1's Light lands.
fn ready_ko(w: &World<'_>, live: &Live) {
    seat_in_light_range(w, live.u1, live.wild);
    w.edit_unit(live.wild, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    force_hit(w, live.id, w.unit(live.u1).skill_ids[0]);
}

fn ko_submit(fx: &Fixture, w: &World<'_>, live: &Live, t: i64) {
    let u1 = w.unit(live.u1);
    submit(fx, a(), t, live.id, live.u1, vec![light(&u1, live.wild)])
        .expect("the KO submit is accepted");
    assert_eq!(
        outcome(w, live.id),
        BattleOutcome::SideAWins,
        "PRECONDITION: the Light KO'd the only wild"
    );
}

/// The `Awards` lines the transcript holds after `BattleEnd`, with their `round`. None may
/// precede `BattleEnd`.
fn awards_after_end(w: &World<'_>, id: u64) -> Vec<(u16, AwardsEvent)> {
    let events = w.events_of(id);
    let end = events
        .iter()
        .position(|e| matches!(e.payload, EventPayload::BattleEnd(_)))
        .expect("the transcript holds the BattleEnd");
    assert!(
        !events[..end]
            .iter()
            .any(|e| matches!(e.payload, EventPayload::Awards(_))),
        "no Awards line precedes BattleEnd"
    );
    events[end + 1..]
        .iter()
        .filter_map(|e| match &e.payload {
            EventPayload::Awards(x) => Some((e.round, *x)),
            _ => None,
        })
        .collect()
}

/// The transcript's `Awards` lines are exactly `payout`'s: one per paid monster (ascending, the
/// essence summed) plus one currency line iff the currency is non-zero, all at the final round.
fn assert_awards(w: &World<'_>, id: u64, payout: &Payout, label: &str) {
    let lines = awards_after_end(w, id);
    let round = w.tactical(id).round;
    assert!(
        lines.iter().all(|(r, _)| *r == round),
        "{label}: every Awards line carries the final round {round}"
    );
    let units: Vec<AwardsEvent> = lines
        .iter()
        .map(|(_, x)| *x)
        .filter(|x| x.unit != CURRENCY_AWARD_UNIT)
        .collect();
    let want: Vec<AwardsEvent> = payout
        .awards
        .iter()
        .map(|aw| AwardsEvent {
            unit: aw.unit,
            xp: aw.xp,
            essence: aw.essence.iter().map(|(_, n)| *n).sum(),
            currency: 0,
        })
        .collect();
    assert_eq!(units, want, "{label}: one Awards line per paid monster");
    let currency: Vec<AwardsEvent> = lines
        .iter()
        .map(|(_, x)| *x)
        .filter(|x| x.unit == CURRENCY_AWARD_UNIT)
        .collect();
    let want_currency = if payout.currency > 0 {
        vec![AwardsEvent {
            unit: CURRENCY_AWARD_UNIT,
            xp: 0,
            essence: 0,
            currency: payout.currency,
        }]
    } else {
        Vec::new()
    };
    assert_eq!(currency, want_currency, "{label}: the currency line");
}

/// A forced pack-2 battle on map 4, deployed (11 → slot 0, 12 → slot 1): u1 (monster 11) waits.
struct Pair2 {
    id: u64,
    u1: u32,
    u2: u32,
    wa: u32,
    wb: u32,
}

fn active_pair_of_two(fx: &Fixture, w: &World<'_>) -> Pair2 {
    let id = deploying_pair(fx, w);
    deploy(fx, a(), T0 + 1_000, id, vec![pick(11, 0), pick(12, 1)]).expect("the pair deploys");
    let players = w.side_units(id, SideRow::A);
    let wilds = w.side_units(id, SideRow::B);
    assert_eq!(
        (players.len(), wilds.len()),
        (2, 2),
        "PRECONDITION: two a side"
    );
    assert_eq!(
        (players[0].monster_id, players[1].monster_id),
        (Some(11), Some(12)),
        "PRECONDITION: picks on their slots"
    );
    let pair = Pair2 {
        id,
        u1: players[0].unit_id,
        u2: players[1].unit_id,
        wa: wilds[0].unit_id,
        wb: wilds[1].unit_id,
    };
    assert_eq!(
        w.tactical(id).turn_state,
        TurnState::Waiting(pair.u1),
        "PRECONDITION: monster 11 holds the first window"
    );
    pair
}

/// Pack 2: u1 KOs wild `dead` with `[Light, EndTurn]`, the battle goes on (`alive` stands) and
/// u2 holds the window. `payout` is the live reference: `on_unit_defeated` against the board
/// right after the KO, then `pay` (nobody else falls before any close below). `m11`/`m12` are the
/// party rows BEFORE the KO step.
struct KoScene {
    id: u64,
    u1: u32,
    u2: u32,
    dead: u32,
    alive: u32,
    payout: Payout,
    victim: Affinity,
    m11: Monster,
    m12: Monster,
    t: i64,
}

fn ko_scene(fx: &Fixture, w: &World<'_>) -> KoScene {
    let p = active_pair_of_two(fx, w);
    let (dead, alive) = (p.wa, p.wb);
    seat_in_light_range(w, p.u1, dead);
    w.edit_unit(dead, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    let u1_row = w.unit(p.u1);
    force_hit(w, p.id, u1_row.skill_ids[0]);
    let (m11, m12) = (w.monster(11), w.monster(12));
    let t = T0 + 20_000;
    submit(
        fx,
        a(),
        t,
        p.id,
        p.u1,
        vec![light(&u1_row, dead), QueuedAction::EndTurn],
    )
    .expect("Light then EndTurn");
    assert_eq!(
        w.unit(dead).state,
        UnitState::Fainted,
        "PRECONDITION: the Light KO'd the wild"
    );
    let tac = w.tactical(p.id);
    assert_eq!(
        (tac.phase, tac.turn_state),
        (Phase::Active, TurnState::Waiting(p.u2)),
        "PRECONDITION: the battle goes on and u2 holds the window"
    );
    let state = loaded(fx, p.id, t).state;
    let dead_species = w.unit(dead).species_id;
    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, &state, p.u1, dead, bst(dead_species))
        .expect("the KO is creditable");
    let payout = pay(&ledger, &state);
    let earners: Vec<u32> = payout.awards.iter().map(|aw| aw.unit).collect();
    assert_eq!(
        earners,
        vec![p.u1.min(p.u2), p.u1.max(p.u2)],
        "non-vacuous: the killer and its side-mate both earn"
    );
    KoScene {
        id: p.id,
        u1: p.u1,
        u2: p.u2,
        dead,
        alive,
        payout,
        victim: affinity_of(dead_species),
        m11,
        m12,
        t,
    }
}

/// Monster 11 (u1) and 12 (u2) hold exactly the scene's ledger award on top of their pre-KO rows,
/// the wallet holds its currency and the transcript names every line.
fn assert_ko_paid(w: &World<'_>, s: &KoScene, label: &str) {
    for (mid, unit, before) in [(11u64, s.u1, &s.m11), (12, s.u2, &s.m12)] {
        let award = s
            .payout
            .awards
            .iter()
            .find(|aw| aw.unit == unit)
            .expect("the scene's payout names the unit");
        let m = w.monster(mid);
        assert_eq!(
            (m.xp, m.level),
            after_gain(before.xp, award.xp),
            "{label}: monster {mid} gains exactly its ledger XP"
        );
        let essence: u32 = award.essence.iter().map(|(_, n)| *n).sum();
        assert_eq!(
            pool(&m, s.victim),
            pool(before, s.victim) + essence,
            "{label}: monster {mid}'s pool of the victim's affinity"
        );
    }
    assert_eq!(
        wallet(w),
        s.payout.currency,
        "{label}: the wallet receives the ledger's currency"
    );
    assert_awards(w, s.id, &s.payout, label);
}

/// A consistent round boundary at `round`: idle budgets, no window, no deadline row,
/// `Advancing` with `order` as the initiative.
fn boundary(w: &World<'_>, id: u64, round: u16, order: &[u32]) {
    for u in w.units_of(id) {
        w.edit_unit(u.unit_id, rest);
    }
    let order = order.to_vec();
    w.edit_tactical(id, |t| {
        t.round = round;
        t.turn_state = TurnState::Advancing;
        t.turn_idx = 0;
        t.initiative = order;
        t.pending_pad_ms = 0;
    });
    w.edit_clock(id, |c| {
        c.window_open_ms = None;
        c.deadline_ms = None;
        c.windows_this_unit_turn = 0;
    });
    for row in w.deadlines_of(id) {
        assert_eq!(w.deadlines.remove(row.scheduled_id), 1);
    }
}

#[derive(Clone, Copy, Debug)]
enum Closer {
    Flee,
    Deadline,
    Disconnect,
    RoundCap,
}

/// Close the scene's battle without a win, by `how`.
fn close_after_ko(fx: &Fixture, w: &World<'_>, s: &KoScene, how: Closer) {
    let t = s.t + 10_000;
    match how {
        Closer::Flee => submit(fx, a(), t, s.id, s.u2, vec![QueuedAction::Flee])
            .expect("u2 flees with its full budget"),
        Closer::Deadline => {
            let deadline = w.clock(s.id).deadline_ms.expect("u2's window is open");
            fire_deadline(fx, deadline, deadline_args(&w.only_deadline(s.id)))
                .expect("the expiry fire is Ok");
        }
        Closer::Disconnect => {
            crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t)), a());
        }
        Closer::RoundCap => {
            let cap = load_tactics_tuning()
                .expect("tactics tuning content loads")
                .wild_round_cap;
            boundary(w, s.id, cap, &[s.u1, s.u2, s.alive]);
            for unit in [s.u1, s.u2] {
                submit(fx, a(), t, s.id, unit, vec![QueuedAction::EndTurn])
                    .expect("a pre-queue at the boundary");
            }
            let row = TacticalAdvanceSched {
                scheduled_id: 7_001,
                scheduled_at: time(t),
                battle_id: s.id,
                round: cap,
            };
            w.advances.seed(&advance_args(&row));
            fire_advance(fx, t, row).expect("the capped round runs");
            assert!(
                w.events_of(s.id).iter().any(|e| matches!(
                    &e.payload,
                    EventPayload::BattleEnd(x) if x.how == EndHow::RoundCap
                )),
                "PRECONDITION: the round cap auto-fled"
            );
        }
    }
    assert_eq!(
        outcome(w, s.id),
        BattleOutcome::Fled,
        "{how:?}: PRECONDITION: the battle fled"
    );
}

// --- prior battles (the sweep) ---------------------------------------------

const PRIOR_TACTICAL: u64 = 900;
const PRIOR_LEGACY: u64 = 901;
const PRIOR_OTHER: u64 = 902;

const TOKEN: StatBlock = StatBlock {
    hp: 10,
    attack: 10,
    defense: 10,
    speed: 10,
    sp_attack: 10,
    sp_defense: 10,
};

fn token_monster() -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity: affinity_of(1),
        level: 5,
        current_hp: 10,
        max_hp: 10,
        stats: TOKEN,
        known_skill_ids: Vec::new(),
        status: None,
    }
}

fn anchor_row(battle_id: u64, player: Identity, outcome: BattleOutcome) -> Battle {
    Battle {
        battle_id,
        player_identity: player,
        opponent_identity: crate::WILD_IDENTITY,
        state: BattleState {
            side_a: BattleSide::with_lead(vec![token_monster()]).expect("a conscious lead"),
            side_b: BattleSide::with_lead(vec![token_monster()]).expect("a conscious lead"),
            outcome,
            turn_number: 0,
            weather: None,
        },
        party_monster_ids: Vec::new(),
        opponent_monster_ids: Vec::new(),
        created_at_ms: T0 - 60_000,
    }
}

fn zero_summary(battle_id: u64, player: Identity, outcome: BattleOutcome) -> BattleSummary {
    BattleSummary {
        battle_id,
        player_identity: player,
        opponent_identity: crate::WILD_IDENTITY,
        kind: BattleKind::Wild,
        outcome,
        rounds: 0,
        wall_ms: 0,
        idle_ms_a: 0,
        idle_ms_b: 0,
        windows_histogram: vec![0; 4],
        autopasses: 0,
        recruit_attempts: 0,
        recruit_successes: 0,
        weaken_first: false,
        items_used: 0,
        damage_dealt_a: 0,
        damage_dealt_b: 0,
        hits: 0,
        misses: 0,
        unit_turns_prequeued: 0,
        unit_turns_live: 0,
        halted_plans: 0,
        se_kos_after_r1: 0,
    }
}

/// A prior battle of `player`: its terminal anchor and, when `tactical`, the rows of a tactical
/// battle a legacy reducer ended mid-round (tactical row still Active, summary still `Ongoing`):
/// event, unit, clock, secret, wild-unit, an armed deadline and a GC row.
fn seed_prior(w: &World<'_>, id: u64, player: Identity, outcome: BattleOutcome, tactical: bool) {
    w.battles.seed(&anchor_row(id, player, outcome));
    if !tactical {
        return;
    }
    let unit_id = 9_000 + u32::try_from(id).expect("a small fixture id");
    w.tacticals.seed(&BattleTactical {
        battle_id: id,
        kind: BattleKind::Wild,
        format: 0,
        map_id: 1,
        content_version: crate::CONTENT_VERSION,
        phase: Phase::Active,
        round: 3,
        initiative: vec![unit_id],
        turn_idx: 0,
        turn_state: TurnState::Waiting(unit_id),
        tie_priority_side: SideRow::A,
        pending_pad_ms: 0,
        attack_damage_dealt_a: 7,
        attack_damage_dealt_b: 0,
    });
    w.events.seed(&BattleEvent {
        event_id: 9_000 + id,
        battle_id: id,
        seq: 0,
        round: 1,
        payload: EventPayload::BattleStarted(BattleStartedEvent { round: 1 }),
    });
    w.units.seed(&BattleUnit {
        unit_id,
        battle_id: id,
        side: SideRow::A,
        owner: Some(player),
        slot: 0,
        monster_id: None,
        wild_index: None,
        species_id: 1,
        level: 5,
        affinity: affinity_of(1),
        x: 1,
        y: 1,
        cur_hp: 10,
        stats: TOKEN,
        skill_ids: vec![1, 2],
        status: None,
        ap: 6,
        strides_used: 0,
        attacks: 0,
        budget_last: None,
        guard: false,
        first_stand: false,
        movement: MoveClassRow::Walk,
        stride: 2,
        stance: None,
        state: UnitState::Active,
    });
    w.clocks.seed(&BattleClock {
        clock_id: 9_000 + id,
        battle_id: id,
        side: SideRow::A,
        player,
        window_seq: 4,
        window_open_ms: Some(T0 - 30_000),
        deadline_ms: Some(T0 + 270_000),
        windows_this_unit_turn: 1,
        idle_ms_total: 1_234,
        autopass_count: 0,
    });
    w.secrets.seed(&BattleSecret {
        battle_id: id,
        seed: 1,
        action_seq: 4,
    });
    w.wild_units.seed(&BattleWildUnit {
        wild_unit_id: 9_000 + id,
        battle_id: id,
        wild_index: 0,
        species_id: 2,
        level: 3,
        individuality_seed: 77,
    });
    w.deadlines.seed(&TacticalDeadlineSched {
        scheduled_id: 9_000 + id,
        scheduled_at: time(T0 + 270_000),
        battle_id: id,
        unit_id,
        window_seq: 4,
    });
    w.gcs.seed(&BattleGcSched {
        scheduled_id: 9_000 + id,
        scheduled_at: time(T0 + DAY_MS),
        battle_id: id,
    });
    w.summaries
        .seed(&zero_summary(id, player, BattleOutcome::Ongoing));
}

/// A's prior tactical battle (legacy-ended, Fled), A's prior 1v1 loss, and B's prior flee.
fn seed_priors(w: &World<'_>) {
    seed_prior(w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    seed_prior(w, PRIOR_LEGACY, a(), BattleOutcome::SideBWins, false);
    seed_prior(w, PRIOR_OTHER, b(), BattleOutcome::Fled, false);
}

fn assert_priors_swept(w: &World<'_>, finishing: u64, label: &str) {
    assert!(
        w.anchor(PRIOR_TACTICAL).is_none(),
        "{label}: A's prior tactical anchor is swept"
    );
    assert!(
        w.anchor(PRIOR_LEGACY).is_none(),
        "{label}: A's prior 1v1 anchor is swept"
    );
    assert!(
        w.try_tactical(PRIOR_TACTICAL).is_none(),
        "{label}: the swept anchor's battle_tactical row goes with it"
    );
    let left: Vec<(&str, usize)> = w
        .per_battle(PRIOR_TACTICAL)
        .into_iter()
        .filter(|&(_, n)| n > 0)
        .collect();
    assert!(
        left.is_empty(),
        "{label}: the swept battle's per-battle rows go: {left:?}"
    );
    assert!(
        w.gcs_of(PRIOR_TACTICAL).is_empty(),
        "{label}: and its GC row"
    );
    assert_eq!(
        summary(w, PRIOR_TACTICAL).outcome,
        BattleOutcome::Fled,
        "{label}: the swept battle's summary survives, finalised with its anchor's outcome"
    );
    assert!(
        w.anchor(finishing).is_some() && w.try_tactical(finishing).is_some(),
        "{label}: the finishing battle's own anchor and tactical row survive"
    );
    assert_eq!(
        summary_rows(w, finishing).len(),
        1,
        "{label}: the finishing battle's summary row survives"
    );
    assert!(
        w.anchor(PRIOR_OTHER).is_some(),
        "{label}: another player's terminal anchor is untouched"
    );
}

fn battle_monster_of(m: &Monster) -> BattleMonster {
    let species = species_def(m.species_id);
    BattleMonster {
        species_id: m.species_id,
        affinity: species.affinity,
        level: m.level,
        current_hp: m.current_hp,
        max_hp: m.stat_hp,
        stats: StatBlock {
            hp: m.stat_hp,
            attack: m.stat_attack,
            defense: m.stat_defense,
            speed: m.stat_speed,
            sp_attack: m.stat_sp_attack,
            sp_defense: m.stat_sp_defense,
        },
        known_skill_ids: species.learnable_skill_ids,
        status: None,
    }
}

fn wild_battle_monster(species_id: u32, level: u8) -> BattleMonster {
    BattleMonster {
        species_id,
        affinity: affinity_of(species_id),
        level,
        current_hp: 1,
        max_hp: 20,
        stats: StatBlock { hp: 20, ..TOKEN },
        known_skill_ids: Vec::new(),
        status: None,
    }
}

/// A 1v1 wild battle value for A's `party` (never stored: the funnel is called on it directly).
fn one_v_one(
    battle_id: u64,
    party: &[Monster],
    wild: BattleMonster,
    outcome: BattleOutcome,
) -> Battle {
    Battle {
        battle_id,
        player_identity: a(),
        opponent_identity: crate::WILD_IDENTITY,
        state: BattleState {
            side_a: BattleSide::with_lead(party.iter().map(battle_monster_of).collect())
                .expect("a conscious lead"),
            side_b: BattleSide::with_lead(vec![wild]).expect("a conscious wild"),
            outcome,
            turn_number: 3,
            weather: None,
        },
        party_monster_ids: party.iter().map(|m| m.monster_id).collect(),
        opponent_monster_ids: Vec::new(),
        created_at_ms: T0,
    }
}

fn species_row_of(s: &game_core::Species) -> SpeciesRow {
    SpeciesRow {
        id: s.id,
        name: s.name.clone(),
        base_hp: s.base_stats.hp,
        base_attack: s.base_stats.attack,
        base_defense: s.base_stats.defense,
        base_speed: s.base_stats.speed,
        base_sp_attack: s.base_stats.sp_attack,
        base_sp_defense: s.base_stats.sp_defense,
        affinity: s.affinity,
        learnable_skill_ids: s.learnable_skill_ids.clone(),
        ability: s.ability,
        tier: s.tier,
    }
}

// ===========================================================================
// BT9.1 — the ledger paid once through the funnel, on every terminal path
// ===========================================================================

#[test]
fn a_live_win_pays_the_killers_ledger_award_and_the_currency_with_one_awards_line_each_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    ready_ko(&w, &live);
    let (m11, m12) = (w.monster(11), w.monster(12));
    let wild_species = w.unit(live.wild).species_id;
    let t1 = T0 + 25_000;
    ko_submit(&fx, &w, &live, t1);
    let fin = loaded(&fx, live.id, t1).state;
    let mut ledger = Ledger::default();
    on_unit_defeated(&mut ledger, &fin, live.u1, live.wild, bst(wild_species))
        .expect("the KO is creditable");
    let payout = pay(&ledger, &fin);
    assert_eq!(
        payout.awards.len(),
        1,
        "non-vacuous: only the conscious killer earns (u2 fell first)"
    );
    let m = w.monster(11);
    assert_eq!(
        (m.xp, m.level),
        after_gain(m11.xp, payout.awards[0].xp),
        "monster 11 gains exactly the ledger's XP"
    );
    let affinity = affinity_of(wild_species);
    assert_eq!(
        pool(&m, affinity),
        pool(&m11, affinity) + essence_battle_reward(bst(wild_species)),
        "the killer's pool of the victim's affinity"
    );
    assert_eq!(
        wallet(&w),
        battle_currency_reward(bst(wild_species)),
        "the player's currency"
    );
    let m2 = w.monster(12);
    assert_eq!(
        (m2.xp, m2.level, pools(&m2)),
        (m12.xp, m12.level, pools(&m12)),
        "a party member that fell before the finish earns nothing"
    );
    assert_awards(&w, live.id, &payout, "win");
}

#[test]
fn a_wild_win_credits_the_daily_trust_to_every_conscious_party_member_deployed_or_benched_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &QUAD);
    let id = start(&fx, a(), seed_for(1, Some(1)), None, T0);
    let players = w.side_units(id, SideRow::A);
    let deployed: Vec<u64> = players.iter().filter_map(|u| u.monster_id).collect();
    assert_eq!(
        deployed,
        vec![11, 12, 13],
        "PRECONDITION: monster 14 is benched"
    );
    let live = Live {
        id,
        u1: players[0].unit_id,
        u2: players[1].unit_id,
        wild: w.side_units(id, SideRow::B)[0].unit_id,
    };
    ready_ko(&w, &live);
    let party = [11u64, 12, 13, 14];
    let before: Vec<u32> = party
        .iter()
        .map(|&mid| w.monster(mid).trust_favorable_count)
        .collect();
    ko_submit(&fx, &w, &live, T0 + 25_000);
    let after: Vec<u32> = party
        .iter()
        .map(|&mid| w.monster(mid).trust_favorable_count)
        .collect();
    let want: Vec<u32> = before.iter().map(|n| n + 1).collect();
    assert_eq!(
        after, want,
        "the carried win-only daily trust credit reaches the whole conscious party"
    );
}

#[test]
fn every_non_win_terminal_after_a_ko_pays_the_same_ledger_through_the_funnel_bt9_1() {
    for how in [
        Closer::Flee,
        Closer::Deadline,
        Closer::Disconnect,
        Closer::RoundCap,
    ] {
        let fx = fixture();
        let w = world(&fx);
        let s = ko_scene(&fx, &w);
        close_after_ko(&fx, &w, &s, how);
        let label = format!("{how:?}");
        assert_ko_paid(&w, &s, &label);
        assert_eq!(
            (
                w.monster(11).trust_favorable_count,
                w.monster(12).trust_favorable_count
            ),
            (s.m11.trust_favorable_count, s.m12.trust_favorable_count),
            "{label}: the daily trust credit is the win's alone"
        );
    }
}

#[test]
fn a_second_close_after_the_settlement_pays_and_records_nothing_more_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    ready_ko(&w, &live);
    let window = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    let t1 = T0 + 25_000;
    ko_submit(&fx, &w, &live, t1);
    assert!(wallet(&w) > 0, "the finish paid the ledger's currency");
    let before = w.snapshot();
    assert_eq!(
        fire_deadline(&fx, deadline, deadline_args(&window)),
        Ok(()),
        "a stale fire after the finish is Ok"
    );
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t1 + 1_000)), a());
    crate::battle::resolve_wild_battle_on_disconnect(&fx.ctx_at(at(t1 + 2_000)), a());
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "no second payout, Awards line, penalty or summary row"
    );
}

#[test]
fn a_recruit_win_pays_the_earlier_ko_and_never_the_recruited_wild_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let s = ko_scene(&fx, &w);
    seat_adjacent(&w, s.u2, s.alive);
    let pct = odds_pct(&w, s.alive, None);
    force_recruit(&w, s.id, pct, true);
    submit(
        &fx,
        a(),
        s.t + 10_000,
        s.id,
        s.u2,
        vec![recruit(s.alive, None)],
    )
    .expect("u2 recruits the last wild");
    assert_eq!(
        outcome(&w, s.id),
        BattleOutcome::SideAWins,
        "PRECONDITION: the last wild recruited ends the battle"
    );
    assert_ko_paid(&w, &s, "recruit win");
}

#[test]
fn a_recruit_win_with_no_ko_pays_nobody_anything_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, true);
    let (m11, m12) = (w.monster(11), w.monster(12));
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, None)],
    )
    .expect("an adjacent full-budget recruit is accepted");
    assert_eq!(
        outcome(&w, live.id),
        BattleOutcome::SideAWins,
        "PRECONDITION: the recruit won"
    );
    for (mid, before) in [(11u64, &m11), (12, &m12)] {
        let m = w.monster(mid);
        assert_eq!(
            (m.xp, m.level, pools(&m)),
            (before.xp, before.level, pools(before)),
            "monster {mid}: a recruit pays no XP and no essence"
        );
    }
    assert_eq!(wallet(&w), 0, "a recruit pays no currency");
    assert!(
        awards_after_end(&w, live.id).is_empty(),
        "no Awards line for a recruit"
    );
}

#[test]
fn a_failed_hp_write_back_pays_and_penalises_nothing_but_still_sweeps_and_summarises_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    ready_ko(&w, &live);
    w.edit_monster(12, |m| m.owner_identity = b());
    seed_prior(&w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    let m11 = w.monster(11);
    let traded = enc(&w.monster(12));
    ko_submit(&fx, &w, &live, T0 + 25_000);
    let m = w.monster(11);
    assert_eq!(
        (m.xp, m.level, pools(&m), m.trust_favorable_count),
        (m11.xp, m11.level, pools(&m11), m11.trust_favorable_count),
        "no credit when the write-back aborted"
    );
    assert_eq!(
        enc(&w.monster(12)),
        traded,
        "the traded-away monster is untouched"
    );
    assert_eq!(wallet(&w), 0, "no currency");
    assert!(awards_after_end(&w, live.id).is_empty(), "no Awards line");
    assert!(
        w.anchor(PRIOR_TACTICAL).is_none() && w.try_tactical(PRIOR_TACTICAL).is_none(),
        "the sweep still ran"
    );
    assert_eq!(
        summary(&w, live.id).outcome,
        BattleOutcome::SideAWins,
        "the summary is still finalised"
    );
}

// ===========================================================================
// BT9.2 — the recruit entry executes
// ===========================================================================

#[test]
fn a_live_recruit_of_a_non_adjacent_wild_is_refused_not_adjacent_and_writes_nothing_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_in_light_range(&w, live.u1, live.wild);
    give(&w, 1, 2);
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    );
    assert_eq!(
        got,
        Err(format!(
            "submit_queue: InvalidNow {{ reason: NotAdjacent {{ target: {} }} }}",
            live.wild
        )),
        "two tiles away is not adjacent"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn an_adjacent_full_budget_recruit_debits_one_bait_and_rolls_once_at_the_shown_odds_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 2);
    let pct = odds_pct(&w, live.wild, Some(1));
    let seq = w.secret(live.id).action_seq;
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("an owned unit (headroom), adjacent, 6/6 AP, bait held: accepted");
    let results = recruit_results(&w, live.id);
    assert_eq!(results.len(), 1, "one attempt resolved");
    assert_eq!(
        (results[0].unit, results[0].target, results[0].pct),
        (live.u1, live.wild, pct),
        "the odds rolled are the odds shown (bait 150 per mille included)"
    );
    assert_eq!(
        held(&w, 1),
        1,
        "the bait is debited in the same transaction"
    );
    assert_eq!(
        w.secret(live.id).action_seq,
        seq + 1,
        "exactly one draw from the private stream"
    );
}

#[test]
fn a_live_recruit_with_a_bait_that_is_no_bait_or_not_held_is_refused_before_any_debit_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 3, 2);
    assert_eq!(
        bait_bonus(3),
        0,
        "PRECONDITION: item 3 carries no recruit bonus"
    );
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(3))],
    );
    assert_eq!(
        got,
        Err("submit_queue: InvalidNow { reason: ItemNotHeld { item_id: 3 } }".to_string()),
        "the bait's content row is judged before the debit"
    );
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "nothing debited, nothing rolled"
    );
    let got = submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(77))],
    );
    assert_eq!(
        got,
        Err("submit_queue: ItemNotHeld { item_id: 77, needed: 1, held: 0 }".to_string()),
        "an id the owner does not hold is refused by the submit gate"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn a_prequeued_recruit_with_a_bait_that_is_no_bait_halts_at_pop_and_debits_nothing_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 3, 2);
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(3))],
    )
    .expect("a pre-queued recruit is stored");
    let seq = w.secret(live.id).action_seq;
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![QueuedAction::EndTurn],
    )
    .expect("u1 ends its turn: u2's plan pops");
    assert_eq!(
        halts(&w, live.id),
        vec![PlanHaltedEvent {
            unit: live.u2,
            idx: 0,
            reason_kind: HaltKind::ItemNotHeld
        }],
        "the bait's content row halts the entry at pop"
    );
    assert_eq!(held(&w, 3), 2, "nothing debited");
    assert!(recruit_results(&w, live.id).is_empty(), "nothing rolled");
    assert_eq!(w.secret(live.id).action_seq, seq, "no draw");
    let ap_turn = load_tactics_tuning()
        .expect("tactics tuning content loads")
        .ap_turn;
    assert_eq!(
        (w.tactical(live.id).turn_state, w.unit(live.u2).ap),
        (TurnState::Waiting(live.u2), ap_turn),
        "halt-and-return: u2 gets its untouched budget back live"
    );
}

#[test]
fn a_seed_forced_recruit_success_rebuilds_the_wild_for_the_owner_and_ends_the_battle_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    let wild_row = w.wild_units_of(live.id)[0].clone();
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, true);
    let t = T0 + 20_000;
    submit(
        &fx,
        a(),
        t,
        live.id,
        live.u1,
        vec![recruit(live.wild, None)],
    )
    .expect("an adjacent full-budget recruit is accepted");
    let got = new_monsters(&w);
    assert_eq!(got.len(), 1, "exactly one new monster");
    let got = &got[0];
    let species = species_def(wild_row.species_id);
    let lvl = level(wild_row.level);
    let inst = game_core::build_monster(wild_row.individuality_seed, &species, lvl);
    let mut want = monster_from_instance(a(), &inst, crate::PARTY_SLOT_NONE);
    want.monster_id = got.monster_id;
    assert_eq!(
        enc(got),
        enc(&want),
        "the wild rebuilt from its battle_wild_unit seed: exact genes, level, stats"
    );
    assert_eq!(
        (got.owner_identity, got.party_slot),
        (a(), crate::PARTY_SLOT_NONE),
        "the owner's box"
    );
    assert_eq!(got.current_hp, got.stat_hp, "full HP");
    assert_eq!(
        got.xp,
        game_core::xp_for_level(lvl).value(),
        "the level's base XP, nothing earned"
    );
    assert_eq!(pools(got), [0; 8], "no essence");
    let projection = w.monster_pub(got.monster_id);
    assert_eq!(
        enc(&projection),
        enc(&pub_from_monster(got, species.tier)),
        "the dual write: the projection mirrors the private row"
    );
    assert_eq!(projection.tier, species.tier);
    assert_eq!(w.unit(live.wild).state, UnitState::Recruited);
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideAWins);
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
}

#[test]
fn a_recruit_success_with_a_second_wild_left_keeps_the_battle_and_the_recruit_never_acts_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let p = active_pair_of_two(&fx, &w);
    seat_adjacent(&w, p.u1, p.wa);
    let pct = odds_pct(&w, p.wa, None);
    force_recruit(&w, p.id, pct, true);
    submit(&fx, a(), T0 + 20_000, p.id, p.u1, vec![recruit(p.wa, None)])
        .expect("u1 recruits wild A");
    assert_eq!(w.unit(p.wa).state, UnitState::Recruited);
    assert_eq!(new_monsters(&w).len(), 1, "the recruit was rebuilt");
    assert_eq!(
        w.tactical(p.id).turn_state,
        TurnState::Waiting(p.u2),
        "u1's turn was consumed; the battle goes on"
    );
    submit(
        &fx,
        a(),
        T0 + 30_000,
        p.id,
        p.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("u2 ends its turn: the wilds' part of the round runs");
    assert!(
        turn_ends_of(&w, p.id, p.wb) > 0,
        "non-vacuous: wild B took its turn after the recruit"
    );
    assert_eq!(
        turn_ends_of(&w, p.id, p.wa),
        0,
        "the recruited wild never acts again"
    );
    let t = w.tactical(p.id);
    assert_eq!(t.phase, Phase::Active, "wild B still stands");
    assert!(
        !t.initiative.contains(&p.wa),
        "the recruited wild left the initiative"
    );
}

#[test]
fn a_seed_forced_recruit_failure_consumes_the_turn_and_bait_and_leaves_the_odds_unchanged_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 1, 2);
    let hp = w.unit(live.wild).cur_hp;
    let pct = odds_pct(&w, live.wild, Some(1));
    force_recruit(&w, live.id, pct, false);
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("the attempt is accepted");
    assert_eq!(
        recruit_results(&w, live.id),
        vec![RecruitResultEvent {
            unit: live.u1,
            target: live.wild,
            success: false,
            pct
        }]
    );
    assert_eq!(
        turn_ends_of(&w, live.id, live.u1),
        1,
        "the turn is consumed"
    );
    let wild = w.unit(live.wild);
    assert_eq!(
        (wild.state, wild.cur_hp),
        (UnitState::Active, hp),
        "the wild stands, unhurt"
    );
    assert!(new_monsters(&w).is_empty(), "no monster on a failure");
    assert_eq!(held(&w, 1), 1, "the bait is spent all the same");
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.u2),
        "PRECONDITION: u2 holds the next window"
    );
    force_recruit(&w, live.id, pct, false);
    submit(
        &fx,
        a(),
        T0 + 30_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("a second attempt is accepted");
    let results = recruit_results(&w, live.id);
    assert_eq!(results.len(), 2);
    assert_eq!(
        (results[1].unit, results[1].pct),
        (live.u2, pct),
        "a failure never moves the odds"
    );
    assert_eq!(held(&w, 1), 0, "the second bait is spent");
}

#[test]
fn a_live_recruit_of_a_wild_without_its_seed_row_is_refused_target_gone_before_any_debit_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 2);
    let row = w.wild_units_of(live.id)[0].clone();
    assert_eq!(w.wild_units.remove(row.wild_unit_id), 1);
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    );
    assert_eq!(
        got,
        Err(format!(
            "submit_queue: InvalidNow {{ reason: TargetGone {{ id: {} }} }}",
            live.wild
        )),
        "a wild that could not be rebuilt is refused before the debit"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
}

#[test]
fn a_prequeued_recruit_of_a_wild_without_its_seed_row_halts_target_gone_spending_nothing_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 1, 2);
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("a pre-queued recruit is stored");
    let row = w.wild_units_of(live.id)[0].clone();
    assert_eq!(w.wild_units.remove(row.wild_unit_id), 1);
    let seq = w.secret(live.id).action_seq;
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![QueuedAction::EndTurn],
    )
    .expect("u1 ends its turn: u2's plan pops");
    assert_eq!(
        halts(&w, live.id),
        vec![PlanHaltedEvent {
            unit: live.u2,
            idx: 0,
            reason_kind: HaltKind::TargetGone
        }]
    );
    assert_eq!(held(&w, 1), 2, "the bait is untouched");
    assert_eq!(w.secret(live.id).action_seq, seq, "no draw");
    let ap_turn = load_tactics_tuning()
        .expect("tactics tuning content loads")
        .ap_turn;
    assert_eq!(w.unit(live.u2).ap, ap_turn, "no AP spent");
    assert_eq!(w.unit(live.wild).state, UnitState::Active);
    assert!(new_monsters(&w).is_empty());
    assert!(
        playtest_rows(&w, live.id).is_empty(),
        "a halted attempt writes no playtest row"
    );
}

#[test]
fn bait_held_only_in_a_trade_escrow_is_refused_at_submit_and_never_debited_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 1);
    let mut escrow = offer(1, a(), b(), Vec::new());
    escrow.initiator_items = vec![TradeItem { item_id: 1, qty: 1 }];
    w.offers.seed(&escrow);
    let before = w.snapshot();
    let got = submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    );
    assert_eq!(
        got,
        Err("submit_queue: ItemNotHeld { item_id: 1, needed: 1, held: 0 }".to_string()),
        "an escrowed stack is not held"
    );
    assert_eq!(changed(&before, &w.snapshot()), none());
    assert_eq!(held(&w, 1), 1);
}

#[test]
fn a_disconnect_voids_a_ready_recruit_plan_without_touching_its_bait_bt9_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 1, 2);
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("a pre-queued recruit is stored");
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(T0 + 20_000)), a());
    assert_eq!(outcome(&w, live.id), BattleOutcome::Fled);
    assert!(
        w.events_of(live.id)
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::QueueVoided(v) if v.unit == live.u2)),
        "the READY plan is voided"
    );
    assert!(recruit_results(&w, live.id).is_empty(), "nothing rolled");
    assert_eq!(held(&w, 1), 2, "the bait is untouched");
}

// ===========================================================================
// BT9.3 — the wild faint penalty on every terminal path, recruit success included
// ===========================================================================

#[test]
fn a_recruit_win_with_a_fainted_party_member_adds_exactly_one_unfavorable_trust_bt9_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    seat_adjacent(&w, live.u1, live.wild);
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, true);
    let before = (
        w.monster(11).trust_unfavorable_count,
        w.monster(12).trust_unfavorable_count,
    );
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, None)],
    )
    .expect("the recruit is accepted");
    assert_eq!(
        outcome(&w, live.id),
        BattleOutcome::SideAWins,
        "PRECONDITION: recruit win"
    );
    assert_eq!(
        (
            w.monster(11).trust_unfavorable_count,
            w.monster(12).trust_unfavorable_count
        ),
        (before.0, before.1 + 1),
        "one unfavorable trust for the fainted member, none for the conscious one"
    );
}

#[derive(Clone, Copy, Debug)]
enum Terminal {
    Win,
    Flee,
    Disconnect,
}

#[test]
fn every_terminal_with_a_fainted_party_member_adds_exactly_one_unfavorable_trust_bt9_3() {
    for how in [Terminal::Win, Terminal::Flee, Terminal::Disconnect] {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        fall_in_battle(&w, live.id, live.u2);
        let before = (
            w.monster(11).trust_unfavorable_count,
            w.monster(12).trust_unfavorable_count,
        );
        let t = T0 + 25_000;
        match how {
            Terminal::Win => {
                ready_ko(&w, &live);
                ko_submit(&fx, &w, &live, t);
            }
            Terminal::Flee => submit(&fx, a(), t, live.id, live.u1, vec![QueuedAction::Flee])
                .expect("a full-AP flee"),
            Terminal::Disconnect => {
                crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t)), a());
            }
        }
        assert_ne!(
            outcome(&w, live.id),
            BattleOutcome::Ongoing,
            "{how:?}: PRECONDITION: the battle ended"
        );
        assert_eq!(
            (
                w.monster(11).trust_unfavorable_count,
                w.monster(12).trust_unfavorable_count
            ),
            (before.0, before.1 + 1),
            "{how:?}: one unfavorable trust for the fainted member"
        );
        crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t + 1_000)), a());
        assert_eq!(
            w.monster(12).trust_unfavorable_count,
            before.1 + 1,
            "{how:?}: exactly once"
        );
    }
}

#[test]
fn an_unloadable_battles_fallback_close_applies_the_faint_penalty_bt9_3() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    let window = w.only_deadline(live.id);
    w.edit_tactical(live.id, |t| t.content_version = crate::CONTENT_VERSION + 1);
    let before = w.monster(12).trust_unfavorable_count;
    assert_eq!(
        fire_deadline(&fx, T0 + 10_000, deadline_args(&window)),
        Ok(()),
        "the fire falls back to a Fled close"
    );
    assert_eq!(
        outcome(&w, live.id),
        BattleOutcome::Fled,
        "PRECONDITION: the fallback close ran"
    );
    assert_eq!(
        w.monster(12).trust_unfavorable_count,
        before + 1,
        "the fallback close penalises the fainted member like every other terminal"
    );
}

// ===========================================================================
// BT9.4 — every terminal path sweeps the player's prior terminal battles once
// ===========================================================================

#[derive(Clone, Copy, Debug)]
enum Finish {
    Win,
    Flee,
    Recruit,
    DeployExpiry,
}

/// Start a battle, seed the priors, then finish it by `how`; returns the finishing battle's id.
fn finish_after_priors(fx: &Fixture, w: &World<'_>, how: Finish) -> u64 {
    let t = T0 + 25_000;
    match how {
        Finish::Win => {
            let live = live_pair(fx, w);
            ready_ko(w, &live);
            seed_priors(w);
            ko_submit(fx, w, &live, t);
            live.id
        }
        Finish::Flee => {
            let live = live_pair(fx, w);
            seed_priors(w);
            submit(fx, a(), t, live.id, live.u1, vec![QueuedAction::Flee]).expect("a full-AP flee");
            live.id
        }
        Finish::Recruit => {
            let live = live_pair(fx, w);
            seat_adjacent(w, live.u1, live.wild);
            let pct = odds_pct(w, live.wild, None);
            force_recruit(w, live.id, pct, true);
            seed_priors(w);
            submit(fx, a(), t, live.id, live.u1, vec![recruit(live.wild, None)])
                .expect("an adjacent full-budget recruit");
            live.id
        }
        Finish::DeployExpiry => {
            let id = deploying_pair(fx, w);
            seed_priors(w);
            let window = w.only_deadline(id);
            fire_deadline(fx, T0 + PVE_WINDOW_MS, deadline_args(&window))
                .expect("the deploy window expires");
            id
        }
    }
}

#[test]
fn every_finish_sweeps_the_players_prior_terminal_anchors_with_their_tactical_rows_bt9_4() {
    for how in [
        Finish::Win,
        Finish::Flee,
        Finish::Recruit,
        Finish::DeployExpiry,
    ] {
        let fx = fixture();
        let w = world(&fx);
        let id = finish_after_priors(&fx, &w, how);
        let label = format!("{how:?}");
        assert_ne!(
            outcome(&w, id),
            BattleOutcome::Ongoing,
            "{label}: PRECONDITION: the battle finished"
        );
        assert_priors_swept(&w, id, &label);
    }
}

#[test]
fn the_one_v_one_write_back_also_sweeps_a_prior_tactical_anchors_rows_bt9_4() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    seed_prior(&w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    let party = [w.monster(11), w.monster(12)];
    let battle = one_v_one(950, &party, wild_battle_monster(2, 3), BattleOutcome::Fled);
    fx.run_as_at(a(), at(T0 + 5_000), |ctx| {
        crate::battle::write_back_battle_results(ctx, &battle)
    })
    .expect("the 1v1 funnel runs");
    assert!(
        w.anchor(PRIOR_TACTICAL).is_none(),
        "PRECONDITION (carried): the prior terminal anchor is swept"
    );
    assert!(
        w.try_tactical(PRIOR_TACTICAL).is_none(),
        "its battle_tactical row goes with it (R-bt-8-TACTICALSWEEP)"
    );
    let left: Vec<(&str, usize)> = w
        .per_battle(PRIOR_TACTICAL)
        .into_iter()
        .filter(|&(_, n)| n > 0)
        .collect();
    assert!(left.is_empty(), "its per-battle rows go: {left:?}");
    assert!(w.gcs_of(PRIOR_TACTICAL).is_empty(), "and its GC row");
    assert_eq!(
        summary_rows(&w, PRIOR_TACTICAL).len(),
        1,
        "its battle_summary survives"
    );
}

// ===========================================================================
// BT9.5 — the summary delta (pure)
// ===========================================================================

const P1: u32 = 1;
const P2: u32 = 2;
const WILD: u32 = 9;
const PLAYERS: [u32; 2] = [P1, P2];

fn prev(waiting: Option<u32>, windows: u8, full_hp: &[u32]) -> StepPrev {
    StepPrev {
        waiting,
        windows,
        full_hp: full_hp.to_vec(),
    }
}

fn step_of(round: u16, events: Vec<EventPayload>) -> StepResult {
    StepResult {
        events,
        round,
        ..StepResult::default()
    }
}

fn turn_ended(unit: u32) -> EventPayload {
    EventPayload::TurnEnded(TurnEndedEvent {
        unit,
        guard: false,
        committed: true,
    })
}

fn bucket(d: &StepDelta, k: usize) -> u32 {
    d.windows.get(k).copied().unwrap_or(0)
}

fn unit_turns(d: &StepDelta) -> u32 {
    d.windows.iter().sum()
}

#[test]
fn step_delta_books_a_live_turn_in_its_window_bucket_and_a_prequeued_turn_in_bucket_zero_bt9_5() {
    let d = step_delta(
        &prev(Some(P1), 2, &[]),
        &step_of(1, vec![turn_ended(P1)]),
        &PLAYERS,
    );
    assert_eq!(
        (d.live, d.prequeued, bucket(&d, 2), unit_turns(&d)),
        (1, 0, 1, 1),
        "the waiting unit's turn ended after its second window"
    );
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(1, vec![turn_ended(P1), turn_ended(P2)]),
        &PLAYERS,
    );
    assert_eq!(
        (
            d.live,
            d.prequeued,
            bucket(&d, 1),
            bucket(&d, 0),
            unit_turns(&d)
        ),
        (1, 1, 1, 1, 2),
        "u2's READY plan ran in the same step: pre-queued, bucket 0"
    );
    let d = step_delta(
        &prev(None, 0, &[]),
        &step_of(2, vec![turn_ended(P1), turn_ended(WILD)]),
        &PLAYERS,
    );
    assert_eq!(
        (d.live, d.prequeued, unit_turns(&d)),
        (0, 1, 1),
        "an advance (no window open) runs pre-queued turns; a wild's is no player unit-turn"
    );
}

#[test]
fn step_delta_skips_a_blocked_turn_and_counts_a_live_turn_cut_by_the_battle_end_bt9_5() {
    let blocked = EventPayload::Status(StatusEvent {
        unit: P2,
        status: StatusEffect::Sleep { turns_remaining: 2 },
        change: StatusChange::Blocked,
        amount: 0,
    });
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(1, vec![turn_ended(P1), blocked, turn_ended(P2)]),
        &PLAYERS,
    );
    assert_eq!(
        (d.live, d.prequeued, unit_turns(&d)),
        (1, 0, 1),
        "a turn a status blocked is neither live nor pre-queued"
    );
    let d = step_delta(
        &prev(Some(P1), 3, &[]),
        &step_of(1, vec![battle_end(BattleOutcome::Fled)]),
        &PLAYERS,
    );
    assert_eq!(
        (d.live, bucket(&d, 3), unit_turns(&d)),
        (1, 1, 1),
        "the waiting unit's turn cut by the end counts, in its window bucket (3: no panic)"
    );
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(
            1,
            vec![turn_ended(P1), battle_end(BattleOutcome::SideAWins)],
        ),
        &PLAYERS,
    );
    assert_eq!(
        (d.live, unit_turns(&d)),
        (1, 1),
        "a turn that ended before the BattleEnd counts once"
    );
}

#[test]
fn step_delta_counts_a_halted_plan_only_for_a_player_unit_other_than_the_waiting_one_bt9_5() {
    let halted = |unit: u32| {
        EventPayload::PlanHalted(PlanHaltedEvent {
            unit,
            idx: 0,
            reason_kind: HaltKind::ItemNotHeld,
        })
    };
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(1, vec![halted(P2)]),
        &PLAYERS,
    );
    assert_eq!(
        d.halted, 1,
        "another player unit's halted READY plan counts"
    );
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(1, vec![halted(P1)]),
        &PLAYERS,
    );
    assert_eq!(
        d.halted, 0,
        "the waiting unit's own live halt is no pre-queued plan"
    );
    let d = step_delta(
        &prev(Some(P1), 1, &[]),
        &step_of(1, vec![halted(WILD)]),
        &PLAYERS,
    );
    assert_eq!(d.halted, 0, "a wild's AI plan is never counted");
}

#[test]
fn step_delta_counts_items_autopasses_recruits_and_hits_from_target_hits_only_bt9_5() {
    let events = vec![
        EventPayload::ItemUsed(ItemUsedEvent {
            unit: P1,
            item_id: 3,
            target: P1,
        }),
        EventPayload::AutoPass(AutoPassEvent {
            unit: P2,
            strike: 1,
        }),
        EventPayload::RecruitResult(RecruitResultEvent {
            unit: P1,
            target: WILD,
            success: true,
            pct: 40,
        }),
        EventPayload::RecruitResult(RecruitResultEvent {
            unit: P2,
            target: WILD,
            success: false,
            pct: 40,
        }),
        executed(
            P1,
            vec![
                target_hit(WILD, 5, false, HitEffectiveness::Neutral),
                target_miss(10),
            ],
        ),
        EventPayload::Missed(MissedEvent {
            attacker: P1,
            target: 10,
        }),
        hit(WILD, P2, 3, false),
    ];
    let d = step_delta(&prev(None, 0, &[]), &step_of(1, events), &PLAYERS);
    assert_eq!(
        (
            d.items,
            d.autopasses,
            d.recruit_attempts,
            d.recruit_successes
        ),
        (1, 1, 2, 1)
    );
    assert_eq!(
        (d.hits, d.misses),
        (2, 1),
        "both sides' TargetHits; the Missed beside a miss adds nothing"
    );
}

#[test]
fn step_delta_counts_a_single_hit_super_effective_ko_after_round_one_only_bt9_5() {
    let se_ko = |attacker: u32, unit: u32| {
        executed(
            attacker,
            vec![target_hit(unit, 50, true, HitEffectiveness::SuperEffective)],
        )
    };
    let count = |round: u16, full_hp: &[u32], events: Vec<EventPayload>| {
        step_delta(
            &prev(Some(P1), 1, full_hp),
            &step_of(round, events),
            &PLAYERS,
        )
        .se_kos_after_r1
    };
    assert_eq!(
        count(2, &[WILD], vec![se_ko(P1, WILD), ko(WILD)]),
        1,
        "round 2, super-effective, from full HP in one hit"
    );
    assert_eq!(
        count(2, &[P2], vec![se_ko(WILD, P2), ko(P2)]),
        1,
        "both sides count"
    );
    assert_eq!(
        count(1, &[WILD], vec![se_ko(P1, WILD), ko(WILD)]),
        0,
        "not in round 1"
    );
    assert_eq!(
        count(2, &[], vec![se_ko(P1, WILD), ko(WILD)]),
        0,
        "not from below full HP"
    );
    assert_eq!(
        count(2, &[WILD], vec![tick(WILD), se_ko(P1, WILD), ko(WILD)]),
        0,
        "a tick earlier in the step makes it no single hit"
    );
    assert_eq!(
        count(
            2,
            &[WILD],
            vec![
                EventPayload::Surge(SurgeEvent {
                    round: 2,
                    unit: WILD,
                    amount: 3
                }),
                se_ko(P1, WILD),
                ko(WILD)
            ]
        ),
        0,
        "a Surge earlier in the step makes it no single hit"
    );
    assert_eq!(
        count(
            2,
            &[WILD],
            vec![hit(P2, WILD, 5, false), se_ko(P1, WILD), ko(WILD)]
        ),
        0,
        "an earlier hit in the step makes it no single hit"
    );
    assert_eq!(
        count(2, &[WILD], vec![hit(P1, WILD, 50, true), ko(WILD)]),
        0,
        "a neutral KO is not super-effective"
    );
}

#[test]
fn apply_delta_saturates_every_counter_and_grows_the_histogram_to_any_bucket_bt9_5() {
    let mut row = zero_summary(42, a(), BattleOutcome::Ongoing);
    row.autopasses = u16::MAX - 1;
    row.hits = u16::MAX;
    row.unit_turns_live = 7;
    row.windows_histogram = vec![u32::MAX, 0, 0, 0];
    let delta = StepDelta {
        windows: vec![5, 0, 0, 1],
        prequeued: 2,
        live: 3,
        autopasses: 5,
        halted: 1,
        recruit_attempts: 2,
        recruit_successes: 1,
        items: 1,
        hits: 9,
        misses: 4,
        se_kos_after_r1: 1,
    };
    let got = apply_delta(row, &delta);
    assert_eq!(got.battle_id, 42);
    assert_eq!(
        got.windows_histogram,
        vec![u32::MAX, 0, 0, 1],
        "per-bucket saturating adds"
    );
    assert_eq!(
        (
            got.autopasses,
            got.hits,
            got.unit_turns_live,
            got.unit_turns_prequeued,
            got.halted_plans,
            got.recruit_attempts,
            got.recruit_successes,
            got.items_used,
            got.misses,
            got.se_kos_after_r1
        ),
        (u16::MAX, u16::MAX, 10, 2, 1, 2, 1, 1, 4, 1),
        "every counter adds, saturating"
    );
    for k in [3usize, 4, 5, 255] {
        let mut windows = vec![0u32; k + 1];
        windows[k] = 1;
        let got = apply_delta(
            zero_summary(42, a(), BattleOutcome::Ongoing),
            &StepDelta {
                windows,
                ..StepDelta::default()
            },
        );
        assert_eq!(
            got.windows_histogram.get(k),
            Some(&1),
            "bucket {k} is booked (the vec grows, never panics)"
        );
        assert_eq!(got.windows_histogram.iter().sum::<u32>(), 1, "bucket {k}");
    }
    let mut long = zero_summary(42, a(), BattleOutcome::Ongoing);
    long.windows_histogram = (1..=9).collect();
    let got = apply_delta(
        long,
        &StepDelta {
            windows: vec![0, 1],
            ..StepDelta::default()
        },
    );
    assert_eq!(
        got.windows_histogram,
        vec![1, 3, 3, 4, 5, 6, 7, 8, 9],
        "a longer stored histogram keeps its tail"
    );
}

// ===========================================================================
// BT9.5 — one summary row per battle (shell)
// ===========================================================================

#[test]
fn a_win_over_three_steps_records_one_summary_row_with_every_counter_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.edit_unit(live.wild, |u| {
        u.stats.hp = 400;
        u.cur_hp = 400;
    });
    seat_in_light_range(&w, live.u1, live.wild);
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("step 1: pre-queue u2");
    let u1 = w.unit(live.u1);
    force_hit(&w, live.id, u1.skill_ids[0]);
    submit(
        &fx,
        a(),
        T0 + 30_000,
        live.id,
        live.u1,
        vec![light(&u1, live.wild)],
    )
    .expect("step 2: a live Light that leaves AP");
    assert_eq!(
        (
            w.tactical(live.id).turn_state,
            w.clock(live.id).windows_this_unit_turn
        ),
        (TurnState::Waiting(live.u1), 2),
        "PRECONDITION: u1 keeps the window, its second"
    );
    w.edit_unit(live.wild, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    force_hit(&w, live.id, u1.skill_ids[0]);
    let t3 = T0 + 60_000;
    submit(&fx, a(), t3, live.id, live.u1, vec![light(&u1, live.wild)]).expect("step 3: the KO");
    assert_eq!(
        outcome(&w, live.id),
        BattleOutcome::SideAWins,
        "PRECONDITION: the win"
    );
    let s = summary(&w, live.id);
    let t = w.tactical(live.id);
    let clock = w.clock(live.id);
    assert_eq!(
        (s.player_identity, s.opponent_identity, s.kind),
        (a(), crate::WILD_IDENTITY, BattleKind::Wild)
    );
    assert_eq!((s.outcome, s.rounds), (BattleOutcome::SideAWins, t.round));
    assert_eq!(
        s.wall_ms,
        u64::try_from(t3 - T0).expect("a positive span"),
        "finish minus the anchor's creation"
    );
    assert!(
        clock.idle_ms_total > 0,
        "non-vacuous: two live submits booked idle time"
    );
    assert_eq!((s.idle_ms_a, s.idle_ms_b), (clock.idle_ms_total, 0));
    assert_eq!(
        (
            s.windows_histogram.get(2),
            s.windows_histogram.iter().sum::<u32>()
        ),
        (Some(&1), 1),
        "one unit-turn (u1's, cut by the win) that opened two windows"
    );
    assert_eq!(
        (s.unit_turns_live, s.unit_turns_prequeued),
        (1, 0),
        "u2's READY row never ran"
    );
    assert_eq!((s.hits, s.misses), (2, 0));
    assert!(t.attack_damage_dealt_a > 0, "non-vacuous: damage was dealt");
    assert_eq!(
        (s.damage_dealt_a, s.damage_dealt_b),
        (t.attack_damage_dealt_a, t.attack_damage_dealt_b)
    );
    assert_eq!(
        (
            s.halted_plans,
            s.recruit_attempts,
            s.recruit_successes,
            s.items_used,
            s.autopasses,
            s.se_kos_after_r1
        ),
        (0, 0, 0, 0, 0, 0)
    );
    assert!(!s.weaken_first, "no recruit attempt, no weaken-first");
}

#[test]
fn a_deploying_close_records_one_zero_counter_summary_row_and_no_faint_penalty_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let mut down = party_monster(a(), (13, 3, 2, 180));
    down.current_hp = 0;
    w.seed_monster(&down);
    let id = start(&fx, a(), seed_for(4, None), Some(2), T0);
    assert_eq!(w.tactical(id).phase, Phase::Deploying, "PRECONDITION");
    let window = w.only_deadline(id);
    fire_deadline(&fx, T0 + PVE_WINDOW_MS, deadline_args(&window))
        .expect("the deploy window expires");
    let s = summary(&w, id);
    assert_eq!(
        (s.player_identity, s.kind, s.outcome, s.rounds),
        (a(), BattleKind::Wild, BattleOutcome::Fled, 0),
        "a battle that never went Active: Fled, zero rounds"
    );
    assert_eq!(
        (
            s.windows_histogram.iter().sum::<u32>(),
            s.unit_turns_live,
            s.unit_turns_prequeued,
            s.hits,
            s.misses,
            s.halted_plans
        ),
        (0, 0, 0, 0, 0, 0),
        "no unit-turn, no hit, no halt"
    );
    assert_eq!(
        (
            s.recruit_attempts,
            s.recruit_successes,
            s.items_used,
            s.autopasses,
            s.se_kos_after_r1,
            s.damage_dealt_a,
            s.damage_dealt_b
        ),
        (0, 0, 0, 0, 0, 0, 0),
        "no recruit, no item, no autopass, no damage"
    );
    assert!(!s.weaken_first);
    assert_eq!(
        w.monster(13).trust_unfavorable_count,
        down.trust_unfavorable_count,
        "a Deploying close applies no faint penalty (its fainted member never fought)"
    );
}

#[test]
fn each_battle_owns_exactly_one_summary_row_from_its_active_start_to_its_finish_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let p = active_pair_of_two(&fx, &w);
    assert_eq!(
        summary(&w, p.id).outcome,
        BattleOutcome::Ongoing,
        "the Active start (after deploy_units) inserted the row; unfinished reads Ongoing"
    );
    submit(&fx, a(), T0 + 20_000, p.id, p.u1, vec![QueuedAction::Flee]).expect("a full-AP flee");
    assert_eq!(
        summary(&w, p.id).outcome,
        BattleOutcome::Fled,
        "the finish finalised the same row"
    );
    let second = start(&fx, a(), seed_for(1, Some(1)), None, T0 + 60_000);
    assert_ne!(second, p.id);
    assert_eq!(summary(&w, second).outcome, BattleOutcome::Ongoing);
    let lead = w.side_units(second, SideRow::A)[0].unit_id;
    submit(
        &fx,
        a(),
        T0 + 90_000,
        second,
        lead,
        vec![QueuedAction::Flee],
    )
    .expect("flee the second battle");
    let mut ids: Vec<u64> = w.summaries.rows().iter().map(|s| s.battle_id).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![p.id.min(second), p.id.max(second)],
        "one row per battle, the swept first battle's included"
    );
}

#[test]
fn a_zero_delta_step_leaves_the_summary_row_byte_identical_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let row = enc(&summary(&w, live.id));
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("a pre-queue executes nothing");
    assert_eq!(
        enc(&summary(&w, live.id)),
        row,
        "a step with nothing to count writes nothing"
    );
}

#[test]
fn a_legacy_ended_close_finalises_the_summary_with_the_legacy_outcome_and_no_new_penalty_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    let window = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    legacy_lost_anchor(&w, &live);
    w.edit_monster(11, |m| m.trust_unfavorable_count = 1);
    assert_eq!(fire_deadline(&fx, deadline, deadline_args(&window)), Ok(()));
    let s = summary(&w, live.id);
    assert_eq!(
        (s.outcome, s.rounds),
        (BattleOutcome::SideBWins, w.tactical(live.id).round),
        "the legacy outcome, the rounds the battle was Active for"
    );
    assert_eq!(
        w.monster(11).trust_unfavorable_count,
        1,
        "the legacy funnel already penalised; this close adds none"
    );
}

#[test]
fn the_battles_first_recruit_attempt_below_half_hp_marks_weaken_first_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    w.edit_unit(live.wild, |u| u.cur_hp = (u.stats.hp / 4).max(1));
    let wild = w.unit(live.wild);
    assert!(
        hp_permille(wild.cur_hp, wild.stats.hp) < WEAKEN_FIRST_PERMILLE,
        "PRECONDITION: the wild is below half HP"
    );
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, false);
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, None)],
    )
    .expect("the attempt is accepted");
    let s = summary(&w, live.id);
    assert_eq!(
        (s.weaken_first, s.recruit_attempts, s.recruit_successes),
        (true, 1, 0)
    );
}

#[test]
fn only_the_first_of_two_recruit_attempts_in_one_step_decides_weaken_first_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let p = active_pair_of_two(&fx, &w);
    seat_adjacent(&w, p.u1, p.wa);
    seat_adjacent(&w, p.u2, p.wb);
    w.edit_unit(p.wb, |u| u.cur_hp = (u.stats.hp / 4).max(1));
    let (a_row, b_row) = (w.unit(p.wa), w.unit(p.wb));
    let (hp_a, hp_b) = (
        hp_permille(a_row.cur_hp, a_row.stats.hp),
        hp_permille(b_row.cur_hp, b_row.stats.hp),
    );
    assert!(
        hp_a >= WEAKEN_FIRST_PERMILLE && hp_b < WEAKEN_FIRST_PERMILLE,
        "PRECONDITION: the first target is healthy, the second weakened"
    );
    submit(&fx, a(), T0 + 10_000, p.id, p.u2, vec![recruit(p.wb, None)])
        .expect("u2 pre-queues a recruit of wild B");
    let (pct_a, pct_b) = (odds_pct(&w, p.wa, None), odds_pct(&w, p.wb, None));
    steer(&w, p.id, 2, |i, roll| {
        roll % 100 >= u64::from(if i == 0 { pct_a } else { pct_b })
    });
    submit(&fx, a(), T0 + 20_000, p.id, p.u1, vec![recruit(p.wa, None)])
        .expect("u1 recruits wild A live; u2's plan pops in the same step");
    let rows: Vec<u16> = playtest_rows(&w, p.id)
        .iter()
        .map(|e| e.hp_permille)
        .collect();
    assert_eq!(
        rows,
        vec![hp_a, hp_b],
        "two attempts, two playtest rows, in order"
    );
    let s = summary(&w, p.id);
    assert_eq!(
        (s.recruit_attempts, s.recruit_successes, s.weaken_first),
        (2, 0, false),
        "the battle's FIRST attempt was at full HP"
    );
}

// ===========================================================================
// BT9.6 — essence and currency paid from the ledger at battle end, amounts unchanged
// ===========================================================================

#[test]
fn a_ko_then_flee_pays_the_victims_essence_and_the_currency_only_at_the_finish_bt9_6() {
    let fx = fixture();
    let w = world(&fx);
    let s = ko_scene(&fx, &w);
    assert_eq!(wallet(&w), 0, "nothing is paid at the KO step");
    assert_eq!(
        pools(&w.monster(11)),
        pools(&s.m11),
        "the killer is not credited mid-battle"
    );
    close_after_ko(&fx, &w, &s, Closer::Flee);
    let victim_bst = bst(w.unit(s.dead).species_id);
    let m = w.monster(11);
    for affinity in AFFINITIES {
        let gained = if affinity == s.victim {
            essence_battle_reward(victim_bst)
        } else {
            0
        };
        assert_eq!(
            pool(&m, affinity),
            pool(&s.m11, affinity) + gained,
            "{affinity:?}: the essence lands in the killer's pool of the victim's affinity only"
        );
    }
    assert_eq!(
        pools(&w.monster(12)),
        pools(&s.m12),
        "the side-mate's share is XP, never essence"
    );
    assert_eq!(
        wallet(&w),
        battle_currency_reward(victim_bst),
        "the currency faucet pays the player at the Flee finish"
    );
}

#[test]
fn a_tactical_ko_pays_exactly_what_the_one_v_one_funnel_pays_for_the_same_wild_bt9_6() {
    // The tactical finish: a party of one KOs a pack of one.
    let (wild_species, wild_level, tactical, tactical_wallet) = {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), 1);
        w.seed_monster(&party_monster(a(), PAIR[0]));
        let id = start(&fx, a(), seed_for(1, Some(1)), None, T0);
        let u1 = w.side_units(id, SideRow::A)[0].clone();
        let wild = w.side_units(id, SideRow::B)[0].clone();
        seat_in_light_range(&w, u1.unit_id, wild.unit_id);
        w.edit_unit(wild.unit_id, |u| {
            u.cur_hp = 1;
            u.first_stand = false;
        });
        force_hit(&w, id, u1.skill_ids[0]);
        submit(
            &fx,
            a(),
            T0 + 25_000,
            id,
            u1.unit_id,
            vec![light(&u1, wild.unit_id)],
        )
        .expect("the KO submit is accepted");
        assert_eq!(
            outcome(&w, id),
            BattleOutcome::SideAWins,
            "PRECONDITION: the tactical win"
        );
        (wild.species_id, wild.level, w.monster(11), wallet(&w))
    };
    // The 1v1 funnel on the same win: same monster, same wild species and level.
    let fx = fixture();
    let w = world(&fx);
    let species_rows = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    for s in game_core::load_species().expect("species content loads") {
        species_rows.seed(&species_row_of(&s));
    }
    w.join(a(), 1);
    let m = party_monster(a(), PAIR[0]);
    w.seed_monster(&m);
    let battle = one_v_one(
        950,
        std::slice::from_ref(&m),
        wild_battle_monster(wild_species, wild_level),
        BattleOutcome::SideAWins,
    );
    fx.run_as_at(a(), at(T0 + 25_000), |ctx| {
        crate::battle::write_back_battle_results(ctx, &battle)
    })
    .expect("the 1v1 funnel pays");
    let legacy = w.monster(11);
    assert!(
        legacy.xp > m.xp && wallet(&w) > 0,
        "non-vacuous: the 1v1 funnel paid"
    );
    assert_eq!(
        (tactical.xp, tactical.level),
        (legacy.xp, legacy.level),
        "the same XP"
    );
    assert_eq!(pools(&tactical), pools(&legacy), "the same essence");
    assert_eq!(tactical_wallet, wallet(&w), "the same currency");
}

// ===========================================================================
// BT9.7 — the H1/H2 playtest row
// ===========================================================================

#[test]
fn a_resolved_recruit_attempt_writes_one_playtest_row_with_the_pre_roll_hp_and_bait_bt9_7() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 2);
    w.edit_unit(live.wild, |u| u.cur_hp = (u.stats.hp / 3).max(1));
    let wild = w.unit(live.wild);
    let hp = hp_permille(wild.cur_hp, wild.stats.hp);
    let pct = odds_pct(&w, live.wild, Some(1));
    force_recruit(&w, live.id, pct, false);
    let t = T0 + 20_000;
    submit(
        &fx,
        a(),
        t,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("the attempt is accepted");
    let want = build_playtest_event(a(), 1, t, live.id, wild.species_id, hp, Some(1), false);
    let got: Vec<_> = playtest_rows(&w, live.id)
        .iter()
        .map(playtest_fields)
        .collect();
    assert_eq!(
        got,
        vec![playtest_fields(&want)],
        "kind 1, the owner, the battle, the wild's species, PRE-roll hp, the bait, the result"
    );
}

#[test]
fn a_successful_attempt_without_bait_writes_its_row_with_bait_zero_and_success_bt9_7() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_adjacent(&w, live.u1, live.wild);
    let wild = w.unit(live.wild);
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, true);
    let t = T0 + 20_000;
    submit(
        &fx,
        a(),
        t,
        live.id,
        live.u1,
        vec![recruit(live.wild, None)],
    )
    .expect("the attempt is accepted");
    let want = build_playtest_event(
        a(),
        1,
        t,
        live.id,
        wild.species_id,
        hp_permille(wild.cur_hp, wild.stats.hp),
        None,
        true,
    );
    let got: Vec<_> = playtest_rows(&w, live.id)
        .iter()
        .map(playtest_fields)
        .collect();
    assert_eq!(got, vec![playtest_fields(&want)]);
}

#[test]
fn a_halted_recruit_attempt_writes_no_playtest_row_bt9_7() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 3, 2);
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(3))],
    )
    .expect("a pre-queued recruit is stored");
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![QueuedAction::EndTurn],
    )
    .expect("u1 ends its turn: u2's plan pops");
    assert_eq!(
        halts(&w, live.id).len(),
        1,
        "PRECONDITION: the attempt halted at pop"
    );
    assert!(
        playtest_rows(&w, live.id).is_empty(),
        "an attempt that never resolved is no attempt"
    );
}
