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
use crate::tactics::tactics_tests::{
    c, deploying_pvp, live_pvp, pvp_boundary, pvp_seed, row_set, seat_in_clear_lane, start_pvp,
    B_PAIR, CONN_B,
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

/// The win-only credits `credit_monster` pays when `favorable`: the daily trust-favorable credit
/// (count + its day anchor) and every Quality-Time accumulator.
fn win_credits(m: &Monster) -> (u32, u32, u32, u32, u32, i64) {
    (
        m.trust_favorable_count,
        m.trust_favorable_battle_day_epoch,
        m.quality_time_ticks_total,
        m.quality_time_accum_ms,
        m.quality_time_window_ms,
        m.quality_time_window_start_ms,
    )
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
        kos_after_r1: 0,
        end_how: None,
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
    let bench = w.monster(14);
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
    let m14 = w.monster(14);
    assert_eq!(
        (m14.xp, m14.level, pools(&m14)),
        (bench.xp, bench.level, pools(&bench)),
        "the benched member gets the trust credit only: it earned no ledger XP and no essence"
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
    // The counter-pin of the recruit-only case below: here a wild WAS defeated, so the win's
    // daily trust credit applies to both conscious members (the KO step itself paid nothing).
    for (mid, before) in [(11u64, &s.m11), (12, &s.m12)] {
        assert_eq!(
            w.monster(mid).trust_favorable_count,
            before.trust_favorable_count + 1,
            "monster {mid}: a won battle that defeated a wild credits the daily trust"
        );
    }
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
    let t = T0 + 20_000;
    let today = crate::battle::day_epoch_utc(t);
    assert!(
        today > m11.trust_favorable_battle_day_epoch
            && today > m12.trust_favorable_battle_day_epoch,
        "PRECONDITION: today's trust credit is still open for both, so a wrongly paid one shows"
    );
    submit(
        &fx,
        a(),
        t,
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
    // A recruit is not a KO: the battle defeated no wild, so the win-only credits (the daily
    // trust-favorable credit and Quality Time) are not paid either.
    for (mid, before) in [(11u64, &m11), (12, &m12)] {
        assert_eq!(
            win_credits(&w.monster(mid)),
            win_credits(before),
            "monster {mid}: a recruit-only win pays no trust-favorable credit and no Quality Time"
        );
    }
}

/// The `Awards` lines ascend by unit id whatever the deploy order. Picks reversed: monster 12 is
/// deployed first (its unit gets the LOWER id) while the anchor's party still lists monster 11
/// first. Monster 11's unit (the faster) KOs a wild, monster 12's unit flees: both earned, and the
/// lines must list the lower unit id first — not the party order.
#[test]
fn awards_lines_ascend_by_unit_id_whatever_the_deploy_order_bt9_1() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pair(&fx, &w);
    deploy(&fx, a(), T0 + 1_000, id, vec![pick(12, 0), pick(11, 1)])
        .expect("the pair deploys, picks reversed");
    let players = w.side_units(id, SideRow::A);
    let unit_of = |mid: u64| {
        players
            .iter()
            .find(|u| u.monster_id == Some(mid))
            .map(|u| u.unit_id)
            .unwrap_or_else(|| panic!("monster {mid} is deployed"))
    };
    let (killer, mate) = (unit_of(11), unit_of(12));
    assert!(
        mate < killer,
        "PRECONDITION: monster 12's unit (deployed first) has the lower unit id"
    );
    assert_eq!(
        w.anchor(id).expect("the anchor exists").party_monster_ids,
        vec![11, 12],
        "PRECONDITION: the anchor's party still lists monster 11 first"
    );
    assert_eq!(
        w.tactical(id).turn_state,
        TurnState::Waiting(killer),
        "PRECONDITION: monster 11's unit (the faster) holds the first window"
    );
    // `ko_scene`'s board with the two party units' ids reversed: the killer stands where u1 stood.
    let (k_at, m_at) = (w.unit(killer), w.unit(mate));
    w.edit_unit(killer, |u| {
        u.x = m_at.x;
        u.y = m_at.y;
    });
    w.edit_unit(mate, |u| {
        u.x = k_at.x;
        u.y = k_at.y;
    });
    let dead = w.side_units(id, SideRow::B)[0].unit_id;
    seat_in_light_range(&w, killer, dead);
    w.edit_unit(dead, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
    });
    let k_row = w.unit(killer);
    force_hit(&w, id, k_row.skill_ids[0]);
    let t = T0 + 20_000;
    submit(
        &fx,
        a(),
        t,
        id,
        killer,
        vec![light(&k_row, dead), QueuedAction::EndTurn],
    )
    .expect("Light then EndTurn");
    assert_eq!(
        w.unit(dead).state,
        UnitState::Fainted,
        "PRECONDITION: the Light KO'd the wild"
    );
    let tac = w.tactical(id);
    assert_eq!(
        (tac.phase, tac.turn_state),
        (Phase::Active, TurnState::Waiting(mate)),
        "PRECONDITION: the battle goes on and monster 12's unit holds the window"
    );
    let state = loaded(&fx, id, t).state;
    let mut ledger = Ledger::default();
    on_unit_defeated(
        &mut ledger,
        &state,
        killer,
        dead,
        bst(w.unit(dead).species_id),
    )
    .expect("the KO is creditable");
    let mut want: Vec<AwardsEvent> = pay(&ledger, &state)
        .awards
        .iter()
        .map(|aw| AwardsEvent {
            unit: aw.unit,
            xp: aw.xp,
            essence: aw.essence.iter().map(|(_, n)| *n).sum(),
            currency: 0,
        })
        .collect();
    want.sort_by_key(|x| x.unit);
    assert_eq!(
        want.iter().map(|x| x.unit).collect::<Vec<u32>>(),
        vec![mate, killer],
        "non-vacuous: the killer and its side-mate both earn"
    );
    submit(&fx, a(), t + 10_000, id, mate, vec![QueuedAction::Flee])
        .expect("monster 12's unit flees with its full budget");
    assert_eq!(
        outcome(&w, id),
        BattleOutcome::Fled,
        "PRECONDITION: the battle fled"
    );
    let got: Vec<AwardsEvent> = awards_after_end(&w, id)
        .into_iter()
        .map(|(_, x)| x)
        .filter(|x| x.unit != CURRENCY_AWARD_UNIT)
        .collect();
    assert_eq!(
        got.iter().map(|x| x.unit).collect::<Vec<u32>>(),
        vec![mate, killer],
        "the Awards lines ascend by unit id (monster 12's unit first), never the party's order"
    );
    assert_eq!(got, want, "each line is its unit's ledger award");
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

/// A recruit SUCCESS whose party-HP write-back fails still commits: the recruited wild exists
/// exactly once (in A's box, rebuilt from its `battle_wild_unit` seed, with its `monster_pub`
/// mirror), the bait is debited exactly once, the battle is terminal and its summary finalised —
/// and NOTHING is paid. The battle carries an earlier KO (`ko_scene`: u1 KOs one wild of a pack of
/// two), so a healthy finish WOULD pay monster 12 its side-mate XP and the player the currency
/// (`a_recruit_win_pays_the_earlier_ko_and_never_the_recruited_wild_bt9_1`); the "nothing paid"
/// half is therefore not vacuous. The write-back is made to fail by handing monster 11 (u1's, not
/// the recruiting u2's) to B after the KO step and before the resolving submit — the
/// ownership-changed refusal `a_failed_hp_write_back_pays_and_penalises_nothing_..._bt9_1` uses.
///
/// Replaces `taming_tests::nh_21ra_recruit_success_commits_when_the_party_hp_write_back_fails`
/// (the 1v1 `attempt_recruit` is deleted, bt-17).
///
/// kills: the finish aborting (`return Err`) on a write-back failure (the submit's `Ok`, the
/// terminal outcome/phase and the finalised summary); the recruit insert made conditional on the
/// write-back succeeding (exactly one new monster); the bait debited twice (one left of two); a
/// payout that ignores the failed write-back (monster 12's XP/pools/trust, the wallet, the Awards
/// lines); a write-back that "fixes" the failure by writing battle HP into B's monster (monster
/// 11's row byte-identical).
#[test]
fn a_recruit_success_whose_party_hp_write_back_fails_still_commits_once_and_pays_nothing_bt17_2() {
    install_log_sink();
    let fx = fixture();
    let w = world(&fx);
    let s = ko_scene(&fx, &w);
    seat_adjacent(&w, s.u2, s.alive);
    give(&w, 1, 2);
    let wild_index = w
        .unit(s.alive)
        .wild_index
        .expect("PRECONDITION: the recruit target is a wild");
    let wild_row = w
        .wild_units_of(s.id)
        .into_iter()
        .find(|r| r.wild_index == wild_index)
        .expect("PRECONDITION: the target wild has its seed row");
    let pct = odds_pct(&w, s.alive, Some(1));
    force_recruit(&w, s.id, pct, true);
    w.edit_monster(11, |m| m.owner_identity = b());
    let traded = enc(&w.monster(11));
    let m12 = w.monster(12);
    assert_eq!(wallet(&w), 0, "PRECONDITION: the KO step paid nothing yet");
    assert!(
        new_monsters(&w).is_empty(),
        "PRECONDITION: no monster beyond the party before the recruit"
    );

    submit(
        &fx,
        a(),
        s.t + 10_000,
        s.id,
        s.u2,
        vec![recruit(s.alive, Some(1))],
    )
    .expect("the recruit commits although the party HP write-back fails");

    assert_eq!(
        outcome(&w, s.id),
        BattleOutcome::SideAWins,
        "the last wild recruited ends the battle"
    );
    assert_eq!(
        w.tactical(s.id).phase,
        Phase::Finished,
        "the battle is terminal"
    );
    assert_eq!(
        summary(&w, s.id).outcome,
        BattleOutcome::SideAWins,
        "the summary is finalised"
    );
    assert_eq!(
        captured_log_lines("tactical_settle_skipped").len(),
        1,
        "the failed write-back took the logged skip path exactly once"
    );

    let got = new_monsters(&w);
    assert_eq!(got.len(), 1, "exactly one recruited monster");
    let got = &got[0];
    let species = species_def(wild_row.species_id);
    let inst =
        game_core::build_monster(wild_row.individuality_seed, &species, level(wild_row.level));
    let mut want = monster_from_instance(a(), &inst, crate::PARTY_SLOT_NONE);
    want.monster_id = got.monster_id;
    assert_eq!(
        enc(got),
        enc(&want),
        "the recruit is the wild rebuilt from its battle_wild_unit seed, in A's box"
    );
    assert_eq!(
        enc(&w.monster_pub(got.monster_id)),
        enc(&pub_from_monster(got, species.tier)),
        "the recruit's public projection mirrors it"
    );
    assert_eq!(held(&w, 1), 1, "the bait is debited exactly once");

    assert_eq!(wallet(&w), 0, "no currency");
    assert!(awards_after_end(&w, s.id).is_empty(), "no Awards line");
    let m = w.monster(12);
    assert_eq!(
        (m.xp, m.level, pools(&m), win_credits(&m)),
        (m12.xp, m12.level, pools(&m12), win_credits(&m12)),
        "monster 12 earns neither its side-mate share nor the win credits"
    );
    assert_eq!(
        enc(&w.monster(11)),
        traded,
        "the traded-away monster is untouched"
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

/// A `Status{Tick}` of `amount` on `unit` (a zero amount is a tick that dealt nothing).
fn tick_of(unit: u32, amount: u16) -> EventPayload {
    EventPayload::Status(StatusEvent {
        unit,
        status: StatusEffect::Poison,
        change: StatusChange::Tick,
        amount,
    })
}

#[test]
fn only_a_tick_or_hit_that_dealt_damage_voids_a_later_single_hit_se_ko_bt9_5() {
    let se_ko = |attacker: u32, unit: u32| {
        executed(
            attacker,
            vec![target_hit(unit, 50, true, HitEffectiveness::SuperEffective)],
        )
    };
    let count = |events: Vec<EventPayload>| {
        step_delta(&prev(Some(P1), 1, &[WILD]), &step_of(2, events), &PLAYERS).se_kos_after_r1
    };
    // The earlier tick: amount 0 dealt nothing (the KO is still a single hit), amount 1 did.
    assert_eq!(
        count(vec![tick_of(WILD, 0), se_ko(P1, WILD), ko(WILD)]),
        1,
        "a zero-amount tick is no earlier damage"
    );
    assert_eq!(
        count(vec![tick_of(WILD, 1), se_ko(P1, WILD), ko(WILD)]),
        0,
        "a one-point tick is earlier damage"
    );
    // The earlier hit: damage 0 (a status-only hit) dealt nothing, damage 1 did.
    assert_eq!(
        count(vec![hit(P2, WILD, 0, false), se_ko(P1, WILD), ko(WILD)]),
        1,
        "a zero-damage hit is no earlier damage"
    );
    assert_eq!(
        count(vec![hit(P2, WILD, 1, false), se_ko(P1, WILD), ko(WILD)]),
        0,
        "a one-point hit is earlier damage"
    );
}

#[test]
fn step_delta_is_zero_exactly_when_every_field_is_default_bt9_5() {
    assert!(StepDelta::default().is_zero(), "the default delta is zero");
    let nonzero = [
        StepDelta {
            windows: vec![0],
            ..StepDelta::default()
        },
        StepDelta {
            prequeued: 1,
            ..StepDelta::default()
        },
        StepDelta {
            live: 1,
            ..StepDelta::default()
        },
        StepDelta {
            autopasses: 1,
            ..StepDelta::default()
        },
        StepDelta {
            halted: 1,
            ..StepDelta::default()
        },
        StepDelta {
            recruit_attempts: 1,
            ..StepDelta::default()
        },
        StepDelta {
            recruit_successes: 1,
            ..StepDelta::default()
        },
        StepDelta {
            items: 1,
            ..StepDelta::default()
        },
        StepDelta {
            hits: 1,
            ..StepDelta::default()
        },
        StepDelta {
            misses: 1,
            ..StepDelta::default()
        },
        StepDelta {
            se_kos_after_r1: 1,
            ..StepDelta::default()
        },
    ];
    for (i, d) in nonzero.iter().enumerate() {
        assert!(!d.is_zero(), "delta #{i} carries one non-default field");
    }
}

#[test]
fn apply_delta_books_every_bucket_whether_the_stored_histogram_is_shorter_equal_or_longer_bt9_5() {
    for (stored, added, want) in [
        (vec![1, 2], vec![10, 20, 30], vec![11, 22, 30]),
        (vec![1, 2, 3], vec![10, 20, 30], vec![11, 22, 33]),
        (vec![1, 2, 3, 4], vec![10, 20, 30], vec![11, 22, 33, 4]),
    ] {
        let mut row = zero_summary(42, a(), BattleOutcome::Ongoing);
        row.windows_histogram = stored.clone();
        let got = apply_delta(
            row,
            &StepDelta {
                windows: added.clone(),
                ..StepDelta::default()
            },
        );
        assert_eq!(
            got.windows_histogram, want,
            "stored {stored:?} + added {added:?}"
        );
    }
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
        kos_after_r1: 0,
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

/// bt-9.5 `finalize_swept_summary`: a swept tactical battle's `Ongoing` summary is finalised from
/// its anchor, clock rows and tactical row — exact values on every Side-B field too.
#[test]
fn a_swept_ongoing_summary_is_finalised_with_both_sides_idle_and_damage_and_zero_wall_time_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    seed_prior(&w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    w.edit_tactical(PRIOR_TACTICAL, |t| t.attack_damage_dealt_b = 5);
    w.clocks.seed(&BattleClock {
        clock_id: 9_999,
        battle_id: PRIOR_TACTICAL,
        side: SideRow::B,
        player: b(),
        window_seq: 0,
        window_open_ms: None,
        deadline_ms: None,
        windows_this_unit_turn: 0,
        idle_ms_total: 4_321,
        autopass_count: 0,
    });
    let anchor = w.anchor(PRIOR_TACTICAL).expect("the seeded prior anchor");
    fx.run_as_at(a(), at(T0 + 5_000), |ctx| {
        super::finalize_swept_summary(ctx, &anchor);
    });
    let want = BattleSummary {
        outcome: BattleOutcome::Fled,
        rounds: 3,
        wall_ms: 0,
        idle_ms_a: 1_234,
        idle_ms_b: 4_321,
        damage_dealt_a: 7,
        damage_dealt_b: 5,
        ..zero_summary(PRIOR_TACTICAL, a(), BattleOutcome::Ongoing)
    };
    assert_eq!(enc(&summary(&w, PRIOR_TACTICAL)), enc(&want));
}

#[test]
fn a_swept_summary_of_a_battle_that_never_left_deploying_books_zero_rounds_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    seed_prior(&w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    w.edit_tactical(PRIOR_TACTICAL, |t| t.phase = Phase::Deploying);
    let anchor = w.anchor(PRIOR_TACTICAL).expect("the seeded prior anchor");
    fx.run_as_at(a(), at(T0 + 5_000), |ctx| {
        super::finalize_swept_summary(ctx, &anchor);
    });
    let want = BattleSummary {
        outcome: BattleOutcome::Fled,
        rounds: 0,
        idle_ms_a: 1_234,
        damage_dealt_a: 7,
        ..zero_summary(PRIOR_TACTICAL, a(), BattleOutcome::Ongoing)
    };
    assert_eq!(enc(&summary(&w, PRIOR_TACTICAL)), enc(&want));
}

#[test]
fn a_swept_summary_that_is_already_terminal_is_left_untouched_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    seed_prior(&w, PRIOR_TACTICAL, a(), BattleOutcome::Fled, true);
    let done = BattleSummary {
        rounds: 9,
        wall_ms: 77_000,
        idle_ms_a: 11,
        idle_ms_b: 22,
        damage_dealt_a: 33,
        damage_dealt_b: 44,
        ..zero_summary(PRIOR_TACTICAL, a(), BattleOutcome::SideAWins)
    };
    assert_eq!(w.summaries.remove(PRIOR_TACTICAL), 1);
    w.summaries.seed(&done);
    let anchor = w.anchor(PRIOR_TACTICAL).expect("the seeded prior anchor");
    fx.run_as_at(a(), at(T0 + 5_000), |ctx| {
        super::finalize_swept_summary(ctx, &anchor);
    });
    assert_eq!(enc(&summary(&w, PRIOR_TACTICAL)), enc(&done));
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

/// The first attempt decides across TRANSACTIONS too: u1 fails at full HP in one submit, u2 tries
/// the same wild at a quarter HP in a later submit — the stored row's attempt count, not a
/// per-transaction flag alone, keeps the second attempt from re-deciding `weaken_first`.
#[test]
fn a_weakened_attempt_in_a_later_step_never_overrides_a_full_hp_first_attempt_bt9_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    let wild = w.unit(live.wild);
    let first_hp = hp_permille(wild.cur_hp, wild.stats.hp);
    assert!(
        first_hp >= WEAKEN_FIRST_PERMILLE,
        "PRECONDITION: the first attempt sees a healthy wild"
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
    .expect("u1's attempt at full HP is accepted");
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.u2),
        "PRECONDITION: u2 holds the next window"
    );
    let first = summary(&w, live.id);
    assert_eq!(
        (first.recruit_attempts, first.weaken_first),
        (1, false),
        "PRECONDITION: the first step stored its attempt"
    );
    w.edit_unit(live.wild, |u| u.cur_hp = (u.stats.hp / 4).max(1));
    let weak = w.unit(live.wild);
    let second_hp = hp_permille(weak.cur_hp, weak.stats.hp);
    assert!(
        second_hp < WEAKEN_FIRST_PERMILLE,
        "PRECONDITION: the second attempt sees a weakened wild"
    );
    let pct = odds_pct(&w, live.wild, None);
    force_recruit(&w, live.id, pct, false);
    submit(
        &fx,
        a(),
        T0 + 30_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, None)],
    )
    .expect("u2's attempt in a later transaction is accepted");
    let rows: Vec<u16> = playtest_rows(&w, live.id)
        .iter()
        .map(|e| e.hp_permille)
        .collect();
    assert_eq!(
        rows,
        vec![first_hp, second_hp],
        "non-vacuous: both attempts resolved, each at the HP it saw"
    );
    let s = summary(&w, live.id);
    assert_eq!(
        (s.weaken_first, s.recruit_attempts, s.recruit_successes),
        (false, 2, 0),
        "the battle's first attempt (full HP) decided; a later step's weakened attempt does not"
    );
}

/// The threshold is strict: exactly half HP (500 per mille) at the battle's first attempt is NOT
/// weaken-first; 499 per mille is.
#[test]
fn weaken_first_needs_strictly_less_than_half_hp_at_the_first_attempt_bt9_5() {
    for (cur_hp, want) in [(500u16, false), (499, true)] {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        seat_adjacent(&w, live.u1, live.wild);
        w.edit_unit(live.wild, |u| {
            u.stats.hp = 1_000;
            u.cur_hp = cur_hp;
        });
        let wild = w.unit(live.wild);
        let seen = hp_permille(wild.cur_hp, wild.stats.hp);
        assert_eq!(
            seen, cur_hp,
            "PRECONDITION: {cur_hp} of 1000 HP is {cur_hp} per mille"
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
            (s.weaken_first, s.recruit_attempts),
            (want, 1),
            "{seen} per mille at the first attempt: weaken_first iff below {WEAKEN_FIRST_PERMILLE}"
        );
    }
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

// ===========================================================================
// BT13.2 — the tactical `playtest_event` kind-1 row is exactly the row the retired 1v1 reducer wrote (pinned literals)
//
// BT9.7 pins the tactical row against `build_playtest_event` — the very helper the row is built
// with, so a mutant in it (or in `hp_permille`) moves the oracle with the code. These tests pin
// the tactical row against LITERALS instead. Until bt-17 the same literals were also asserted on
// the shipped 1v1 `taming::attempt_recruit`; bt-17 deleted that reducer, so the literal tuple —
// the value both paths were measured equal to — is the pinned 1v1 row.
// ===========================================================================

/// The wild's HP: 20 of 30 is 666 per mille (floor; a round-half-up mutant says 667).
const BT13_WILD_MAX: u16 = 30;
const BT13_WILD_CUR: u16 = 20;

/// `(identity, kind, species_id, hp_permille, bait_item_id, success)`: the columns
/// `scripts/playtest-report.mjs` groups (identity, species) and computes (hp, bait, success) from.
type Bt13Row = (Identity, u16, u32, u16, u32, bool);

fn bt13_row(e: &PlaytestEvent) -> Bt13Row {
    (
        e.identity,
        e.kind,
        e.species_id,
        e.hp_permille,
        e.bait_item_id,
        e.success,
    )
}

/// The WHOLE `playtest_event` table in insertion order (never the battle-filtered helper).
fn bt13_table(w: &World<'_>) -> Vec<PlaytestEvent> {
    let mut rows = w.playtests.rows();
    rows.sort_by_key(|e| e.event_id);
    rows
}

/// What the tactical attempt left behind, read off the store.
struct Bt13Run {
    table: Vec<PlaytestEvent>,
    /// Monsters minted for the player (a recruit success).
    minted: usize,
    /// The player's bait stock after the attempt (it started at 2).
    bait_left: u32,
    outcome: BattleOutcome,
    /// The id of the battle that was played (the tactical anchor's).
    battle_id: u64,
}

/// The first encounter seed on `map_id` whose forced `pack` wilds satisfy `ok` (their species in
/// slot order), found by really starting battles — each probe is a fresh fixture, dropped before
/// the next, so call this BEFORE building the test's own fixture. Probes at most 300 map hits,
/// then `None`.
fn bt13_try_find_seed(map_id: u32, pack: u8, ok: impl Fn(&[u32]) -> bool) -> Option<u64> {
    let zone = game_core::tactics::load_tactics_zones()
        .expect("tactics zone content loads")
        .into_iter()
        .find(|z| z.zone_id == 0)
        .expect("zone 0 has a tactics zone row");
    let mut tried = 0;
    for seed in 1..100_000u64 {
        let idx = game_core::tactics::pick_map_index(zone.battle_map_pool.len(), seed)
            .expect("zone 0 has a map pool");
        if zone.battle_map_pool[idx] != map_id {
            continue;
        }
        if tried >= 300 {
            return None;
        }
        tried += 1;
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), 1);
        w.seed_party(a(), &PAIR);
        let id = start(&fx, a(), seed, Some(pack), T0);
        // The wild rows exist from the start (a pack >= 2 has no unit rows until it deploys).
        let species: Vec<u32> = w.wild_units_of(id).iter().map(|u| u.species_id).collect();
        if ok(&species) {
            return Some(seed);
        }
    }
    None
}

fn bt13_find_seed(map_id: u32, pack: u8, ok: impl Fn(&[u32]) -> bool) -> u64 {
    bt13_try_find_seed(map_id, pack, ok).unwrap_or_else(|| {
        panic!("no seed fields {pack} wild(s) on map {map_id} as the test needs")
    })
}

/// A pack-1 wild whose species is neither party monster's (u1 acts in most tests, u2 in the
/// pre-queued one), so a row that recorded an actor's species instead of the target's cannot hide.
fn bt13_pack_one_seed() -> u64 {
    bt13_find_seed(1, 1, |species| {
        species.len() == 1 && species[0] != PAIR[0].1 && species[0] != PAIR[1].1
    })
}

/// A started pack-1 `live_pair` world on `seed` (the helper `live_pair` fixes the seed).
fn bt13_live(fx: &Fixture, w: &World<'_>, seed: u64) -> Live {
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(fx, a(), seed, Some(1), T0);
    let players = w.side_units(id, SideRow::A);
    let wilds = w.side_units(id, SideRow::B);
    assert_eq!(
        (players.len(), wilds.len()),
        (2, 1),
        "a pack-1 start fields the whole PAIR and one wild"
    );
    let live = Live {
        id,
        u1: players[0].unit_id,
        u2: players[1].unit_id,
        wild: wilds[0].unit_id,
    };
    assert_eq!(
        w.tactical(id).turn_state,
        TurnState::Waiting(live.u1),
        "PRECONDITION: the fastest party member holds the first window"
    );
    live
}

/// The wild at 20 of 30 HP.
fn bt13_weaken(w: &World<'_>, wild: u32) {
    w.edit_unit(wild, |u| {
        u.stats.hp = BT13_WILD_MAX;
        u.cur_hp = BT13_WILD_CUR;
    });
}

/// One tactical recruit attempt by the waiting unit on a wild seated next to it, the roll steered
/// to `success`. Returns the run and the wild's species (read off its unit row).
fn bt13_tactical_attempt(seed: u64, bait: Option<u32>, success: bool) -> (Bt13Run, u32) {
    let fx = fixture();
    let w = world(&fx);
    let live = bt13_live(&fx, &w, seed);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 2);
    bt13_weaken(&w, live.wild);
    let species = w.unit(live.wild).species_id;
    let pct = odds_pct(&w, live.wild, bait);
    force_recruit(&w, live.id, pct, success);
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, bait)],
    )
    .expect("the tactical attempt is accepted");
    let run = Bt13Run {
        table: bt13_table(&w),
        minted: new_monsters(&w).len(),
        bait_left: held(&w, 1),
        outcome: outcome(&w, live.id),
        battle_id: live.id,
    };
    (run, species)
}

/// The tactical row at a wild of 20 / 30 HP, with the given bait and the wanted result, against
/// the LITERAL tuple the 1v1 `attempt_recruit` wrote for the same inputs (the 1v1 path is deleted
/// since bt-17, so the literals it was measured equal to are now pinned on their own).
fn bt13_assert_parity(bait: Option<u32>, success: bool) {
    let seed = bt13_pack_one_seed();
    let (run, species) = bt13_tactical_attempt(seed, bait, success);
    assert!(
        species != 0 && species != PAIR[0].1 && species != PAIR[1].1,
        "PRECONDITION: the wild's species ({species}) is neither 0 nor a party monster's"
    );
    let bait_literal: u32 = if bait.is_some() { 1 } else { 0 };
    // Literals: the player, kind 1, the wild's species, 20/30 -> 666 (floor), the bait id or 0.
    let want: Bt13Row = (a(), 1, species, 666, bait_literal, success);
    assert_eq!(
        run.table.len(),
        1,
        "exactly one row in the WHOLE playtest_event table"
    );
    assert_eq!(
        bt13_row(&run.table[0]),
        want,
        "(identity, kind, species, hp_permille, bait, success) against the pinned 1v1 literals"
    );
    assert_eq!(
        run.table[0].battle_id, run.battle_id,
        "the row names the battle that was played (the live anchor id)"
    );
    assert_eq!(
        run.bait_left,
        if bait.is_some() { 1 } else { 2 },
        "the bait stock moved iff a bait was named"
    );
    if success {
        assert_eq!(run.minted, 1, "PRECONDITION: a monster was minted");
        assert_eq!(
            run.outcome,
            BattleOutcome::SideAWins,
            "PRECONDITION: the recruit ended the battle in a win"
        );
    } else {
        assert_eq!(run.minted, 0, "PRECONDITION: nothing was minted");
        assert_eq!(
            run.outcome,
            BattleOutcome::Ongoing,
            "PRECONDITION: the battle goes on"
        );
    }
}

#[test]
fn the_tactical_recruit_row_matches_the_pinned_one_v_one_literals_on_a_success_with_bait_bt13_2() {
    bt13_assert_parity(Some(1), true);
}

#[test]
fn the_tactical_recruit_row_matches_the_pinned_one_v_one_literals_on_a_failure_with_bait_bt13_2() {
    bt13_assert_parity(Some(1), false);
}

#[test]
fn the_tactical_recruit_row_matches_the_pinned_one_v_one_literals_on_a_success_without_bait_bt13_2()
{
    bt13_assert_parity(None, true);
}

#[test]
fn the_tactical_recruit_row_matches_the_pinned_one_v_one_literals_on_a_failure_without_bait_bt13_2()
{
    bt13_assert_parity(None, false);
}

/// A failure then a success in later transactions: the whole table holds one row, then two, in
/// order, both under the report's group key `(identity, species_id)`.
#[test]
fn two_tactical_attempts_write_two_ordered_rows_under_one_report_group_key_bt13_2() {
    let seed = bt13_pack_one_seed();
    let fx = fixture();
    let w = world(&fx);
    let live = bt13_live(&fx, &w, seed);
    seat_between(&w, &live);
    give(&w, 1, 2);
    bt13_weaken(&w, live.wild);
    let species = w.unit(live.wild).species_id;
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
    .expect("u1's attempt is accepted");
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.u2),
        "PRECONDITION: the failed attempt leaves the battle on, with u2's window open"
    );
    let first = bt13_table(&w);
    assert_eq!(first.len(), 1, "one attempt, one row in the whole table");

    // A second, weaker sighting: 10 of 30 HP is 333 per mille.
    w.edit_unit(live.wild, |u| u.cur_hp = 10);
    let pct = odds_pct(&w, live.wild, Some(1));
    force_recruit(&w, live.id, pct, true);
    submit(
        &fx,
        a(),
        T0 + 30_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("u2's attempt in a later transaction is accepted");
    let table = bt13_table(&w);
    assert_eq!(table.len(), 2, "two attempts, two rows in the whole table");
    assert!(
        table[0].event_id < table[1].event_id,
        "the rows are in attempt order"
    );
    let rows: Vec<Bt13Row> = table.iter().map(bt13_row).collect();
    assert_eq!(
        rows,
        vec![
            (a(), 1, species, 666, 0, false),
            (a(), 1, species, 333, 1, true)
        ],
        "the failure at 666 without bait, then the success at 333 with bait 1"
    );
    // Both rows share the report's group key (identity, species_id): implied by the literal
    // equality above (same `a()`, same `species` in both tuples).
    assert!(
        table.iter().all(|e| e.battle_id == live.id),
        "both rows name the live battle"
    );
}

/// A recruit pre-queued by u2 resolves when u1's end-turn pops it: exactly one row in the whole
/// table (not zero — the pop path records — and not two).
#[test]
fn a_pre_queued_recruit_resolving_at_pop_writes_exactly_one_row_bt13_2() {
    let seed = bt13_pack_one_seed();
    let fx = fixture();
    let w = world(&fx);
    let live = bt13_live(&fx, &w, seed);
    seat_between(&w, &live);
    give(&w, 1, 2);
    bt13_weaken(&w, live.wild);
    let species = w.unit(live.wild).species_id;
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u2,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("a pre-queued recruit is stored");
    assert!(
        bt13_table(&w).is_empty(),
        "a stored plan has resolved nothing: no row yet"
    );
    let pct = odds_pct(&w, live.wild, Some(1));
    force_recruit(&w, live.id, pct, false);
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![QueuedAction::EndTurn],
    )
    .expect("u1 ends its turn: u2's plan pops");
    assert!(
        halts(&w, live.id).is_empty(),
        "PRECONDITION: the plan resolved, it did not halt"
    );
    assert_eq!(
        recruit_results(&w, live.id).len(),
        1,
        "PRECONDITION: exactly one recruit resolved"
    );
    let table = bt13_table(&w);
    assert_eq!(table.len(), 1, "one resolved attempt, one row, whole table");
    assert_eq!(
        bt13_row(&table[0]),
        (a(), 1, species, 666, 1, false),
        "the pop-time row carries the pre-roll HP, the bait and the result"
    );
    assert_eq!(
        table[0].battle_id, live.id,
        "the pop-time row names the live battle"
    );
}

/// The server must roll the recruit at the BAIT odds, not merely record the bait. With bait 1 the
/// roll is steered into the window `[pct_no_bait, pct_bait)`: it succeeds iff the roll used the
/// bait odds, so a server that rolled at the no-bait odds (while still recording bait 1) fails
/// here. A roll below both thresholds — what the plain steering above usually lands on — cannot
/// tell the two apart.
#[test]
fn the_recruit_roll_uses_the_bait_odds_not_just_the_recorded_bait_bt13_2() {
    let seed = bt13_pack_one_seed();
    let fx = fixture();
    let w = world(&fx);
    let live = bt13_live(&fx, &w, seed);
    seat_adjacent(&w, live.u1, live.wild);
    give(&w, 1, 2);
    bt13_weaken(&w, live.wild);
    let species = w.unit(live.wild).species_id;
    let pct_no_bait = odds_pct(&w, live.wild, None);
    let pct_bait = odds_pct(&w, live.wild, Some(1));
    assert!(
        pct_no_bait < pct_bait,
        "PRECONDITION: the bait widens the odds ({pct_no_bait} < {pct_bait})"
    );
    let (lo, hi) = (u64::from(pct_no_bait), u64::from(pct_bait));
    steer(&w, live.id, 1, |_, roll| {
        lo <= roll % 100 && roll % 100 < hi
    });
    submit(
        &fx,
        a(),
        T0 + 20_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("the attempt is accepted");
    let results = recruit_results(&w, live.id);
    assert_eq!(
        results.len(),
        1,
        "PRECONDITION: exactly one recruit resolved"
    );
    assert_eq!(
        (results[0].success, results[0].pct),
        (true, pct_bait),
        "the roll succeeds in the window only if it was judged against the bait odds"
    );
    let table = bt13_table(&w);
    assert_eq!(table.len(), 1, "one attempt, one row, whole table");
    assert_eq!(
        bt13_row(&table[0]),
        (a(), 1, species, 666, 1, true),
        "the row says success with bait 1"
    );
}

/// A two-species pack, the SECOND wild recruited: its row names that wild's species and HP, not
/// the first wild's and not the actor's.
#[test]
fn recruiting_the_second_wild_of_a_two_species_pack_records_that_wilds_species_and_hp_bt13_2() {
    let actor_species = PAIR[0].1;
    let seed = bt13_find_seed(4, 2, |s| {
        s.len() == 2 && s[0] != s[1] && s[1] != actor_species
    });
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &PAIR);
    let id = start(&fx, a(), seed, Some(2), T0);
    deploy(&fx, a(), T0 + 1_000, id, vec![pick(11, 0), pick(12, 1)]).expect("the pair deploys");
    let players = w.side_units(id, SideRow::A);
    let wilds = w.side_units(id, SideRow::B);
    assert_eq!(
        (players.len(), wilds.len()),
        (2, 2),
        "PRECONDITION: two a side"
    );
    let (u1, first, second) = (players[0].unit_id, wilds[0].clone(), wilds[1].clone());
    assert_eq!(
        w.tactical(id).turn_state,
        TurnState::Waiting(u1),
        "PRECONDITION: monster 11 holds the first window"
    );
    assert_ne!(
        first.species_id, second.species_id,
        "PRECONDITION: the pack has two species"
    );
    seat_adjacent(&w, u1, second.unit_id);
    give(&w, 1, 2);
    bt13_weaken(&w, second.unit_id);
    let seen = |unit: &crate::schema::BattleUnit| hp_permille(unit.cur_hp, unit.stats.hp);
    assert_eq!(
        seen(&w.unit(second.unit_id)),
        666,
        "PRECONDITION: the target sits at 666 per mille"
    );
    assert!(
        seen(&w.unit(u1)) != 666 && seen(&w.unit(first.unit_id)) != 666,
        "PRECONDITION: neither the actor nor the first wild is at the target's HP"
    );
    let pct = odds_pct(&w, second.unit_id, Some(1));
    force_recruit(&w, id, pct, true);
    submit(
        &fx,
        a(),
        T0 + 20_000,
        id,
        u1,
        vec![recruit(second.unit_id, Some(1))],
    )
    .expect("the attempt on the second wild is accepted");
    let table = bt13_table(&w);
    assert_eq!(table.len(), 1, "one attempt, one row, whole table");
    assert_eq!(
        bt13_row(&table[0]),
        (a(), 1, second.species_id, 666, 1, true),
        "the row names the TARGET wild's species and HP"
    );
    assert_eq!(table[0].battle_id, id, "the row names the live battle");
    let minted = new_monsters(&w);
    assert_eq!(
        minted.iter().map(|m| m.species_id).collect::<Vec<u32>>(),
        vec![second.species_id],
        "the monster minted is the second wild's species (the row and the recruit agree)"
    );
}

// ===========================================================================
// bt-14 — PvP endings and the PvP settle (spec M-battle-tactics BT14.5, BT14.6)
// ===========================================================================
//
// SOURCE OF TRUTH: spec §bt-14 BT14.5 / BT14.6, design §6.1 / §6.4 / §7, the plan's §1 contract
// as amended by REV 2 (memory/projects/monster-realm-bt-14-plan.md). Names end `_bt14_N`. RED REASON
// at the API freeze: `start_pvp_tactical` refuses, so every PvP scenario stops at its start; `forfeit`
// refuses "forfeit: unimplemented"; `step_delta` / `apply_delta` ignore `kos_after_r1`; an
// anchor-less finish leaves its summary `Ongoing`.
//
// Ratings are read against the carried rule exactly as `pvp_tests`'
// `nh_forfeit_on_disconnect_settles_both_roles_and_rates_once` reads them: a first rated game between
// two fresh players is `compute_rating_update(INITIAL_RATING, INITIAL_RATING)` — (winner, loser).

/// The carried M17 rating of a first rated game: `(winner, loser)`.
fn first_game_ratings() -> (i32, i32) {
    game_core::compute_rating_update(game_core::INITIAL_RATING, game_core::INITIAL_RATING)
}

fn forfeit(fx: &Fixture, who: Identity, now: i64, id: u64) -> Result<(), String> {
    fx.run_as_at(who, at(now), |ctx| crate::tactics::forfeit(ctx, id))
}

/// The battle's `BattleEnd` payloads.
fn battle_ends(w: &World<'_>, id: u64) -> Vec<BattleEndEvent> {
    w.events_of(id)
        .into_iter()
        .filter_map(|e| match e.payload {
            EventPayload::BattleEnd(x) => Some(x),
            _ => None,
        })
        .collect()
}

/// `unit` holds a READY row that was voided (`QueueVoided`) and never ran (no `TurnEnded`, no
/// `Executed`, no `Moved` naming it), and no READY row of the battle is left.
fn assert_voided_unexecuted(w: &World<'_>, id: u64, unit: u32, label: &str) {
    let events = w.events_of(id);
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::QueueVoided(v) if v.unit == unit)),
        "{label}: unit {unit}'s READY row is voided"
    );
    assert!(
        !events.iter().any(|e| match &e.payload {
            EventPayload::TurnEnded(t) => t.unit == unit,
            EventPayload::Executed(x) => x.attacker == unit,
            EventPayload::Moved(m) => m.unit == unit,
            _ => false,
        }),
        "{label}: unit {unit}'s READY row never executes"
    );
    assert!(
        w.queues_of(id).is_empty(),
        "{label}: every READY row is deleted"
    );
}

/// `pools(m)` with `add` more essence in the `affinity` pool.
fn pools_plus(m: &Monster, affinity: Affinity, add: u32) -> [u32; 8] {
    let mut out = pools(m);
    let i = AFFINITIES
        .iter()
        .position(|&x| x == affinity)
        .expect("every affinity has a pool");
    out[i] += add;
    out
}

/// `attacker` KOs `victim` with its Light (`[Light, EndTurn]`, sent by `who`): the two seated in a
/// clear lane, the victim at 1 HP with First-Stand spent, no Guard and soft defences, the accuracy
/// roll steered to land.
fn pvp_ko(fx: &Fixture, w: &World<'_>, id: u64, who: Identity, attacker: u32, victim: u32, t: i64) {
    seat_in_clear_lane(w, id, attacker, victim);
    w.edit_unit(victim, |u| {
        u.cur_hp = 1;
        u.first_stand = false;
        u.guard = false;
        u.stats.defense = 10;
        u.stats.sp_defense = 10;
    });
    let row = w.unit(attacker);
    force_hit(w, id, row.skill_ids[0]);
    submit(
        fx,
        who,
        t,
        id,
        attacker,
        vec![light(&row, victim), QueuedAction::EndTurn],
    )
    .expect("the KO submit is accepted");
    assert_eq!(
        w.unit(victim).state,
        UnitState::Fainted,
        "PRECONDITION: the Light KO'd unit {victim}"
    );
}

/// Fire a round-boundary advance for `round` at `t` (seeded as the runtime would hold it).
fn run_round(fx: &Fixture, w: &World<'_>, id: u64, round: u16, t: i64) {
    let row = TacticalAdvanceSched {
        scheduled_id: 7_301,
        scheduled_at: time(t),
        battle_id: id,
        round,
    };
    w.advances.seed(&advance_args(&row));
    fire_advance(fx, t, row).expect("the boundary fire is Ok");
}

// ---------------------------------------------------------------------------
// BT14.5 — forfeit, disconnect, Surge, adjudication: one funnel, `end_how` recorded
// ---------------------------------------------------------------------------

/// `forfeit` refuses, writing nothing: a stranger ("not owner"), a missing battle, a WILD battle
/// ("not a PvP battle": Flee is the wild exit), a Deploying PvP battle ("battle is not active", for
/// either participant).
///
/// WRONG IMPL KILLED: the freeze ("forfeit: unimplemented" everywhere); a participant check that
/// admits any identity; a forfeit of a wild battle (a free AutoFlee the clock was meant to own); a
/// rated "forfeit" of a battle nobody has deployed into.
#[test]
fn forfeit_refuses_a_stranger_a_wild_battle_and_a_deploying_battle_bt14_5() {
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        w.join(c(), 3);
        let before = w.snapshot();
        assert_eq!(
            forfeit(&fx, c(), T0 + 9_000, live.id),
            Err("not owner".to_string())
        );
        assert_eq!(
            forfeit(&fx, a(), T0 + 9_000, 4_242),
            Err("battle not found".to_string())
        );
        assert_eq!(changed(&before, &w.snapshot()), none());
    }
    {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pair(&fx, &w);
        let before = w.snapshot();
        assert_eq!(
            forfeit(&fx, a(), T0 + 9_000, live.id),
            Err("not a PvP battle".to_string())
        );
        assert_eq!(changed(&before, &w.snapshot()), none());
    }
    {
        let fx = fixture();
        let w = world(&fx);
        let id = deploying_pvp(&fx, &w, &PAIR, &B_PAIR, 2);
        let before = w.snapshot();
        for who in [a(), b()] {
            assert_eq!(
                forfeit(&fx, who, T0 + 9_000, id),
                Err("battle is not active".to_string()),
                "{who}"
            );
        }
        assert_eq!(changed(&before, &w.snapshot()), none());
    }
}

/// A's forfeit of an Active PvP battle: the opponent wins through the one funnel — anchor
/// `SideBWins`, `BattleEnd{SideBWins, Forfeit}` (no `Awards` before it), A's READY row voided and
/// deleted, never executed, BOTH sides' unit HP written into their monster rows, the summary
/// finalised `SideBWins` with `end_how = Forfeit`, ratings moved once, the GC armed and no deadline
/// left. A second forfeit (by either player) is "battle is not ongoing" and moves nothing again.
///
/// WRONG IMPL KILLED: the freeze; a forfeit mapped to the forfeiter's own side; a forfeit that
/// executes READY rows; side B's HP never written back (or written into side A's monsters); the
/// summary left without its `end_how`; a forfeit that bypasses `settle_pvp_battle` (unrated) or rates
/// on every call.
#[test]
fn forfeit_by_side_a_ends_side_b_wins_voids_ready_rows_writes_both_sides_hp_and_rates_once_bt14_5()
{
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    submit(
        &fx,
        a(),
        T0 + 8_000,
        live.id,
        live.a[1],
        vec![QueuedAction::EndTurn],
    )
    .expect("A pre-queues its second unit");
    w.edit_unit(live.a[0], |u| u.cur_hp = 123);
    w.edit_unit(live.b[0], |u| u.cur_hp = 77);
    let t = T0 + 9_000;
    assert_eq!(forfeit(&fx, a(), t, live.id), Ok(()));
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideBWins);
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    assert_eq!(
        battle_ends(&w, live.id),
        vec![BattleEndEvent {
            outcome: BattleOutcome::SideBWins,
            how: EndHow::Forfeit
        }]
    );
    assert!(
        awards_after_end(&w, live.id).is_empty(),
        "no KO: no Awards line"
    );
    assert_voided_unexecuted(&w, live.id, live.a[1], "forfeit");
    for (mid, hp) in [(11u64, 123u16), (12, 300), (21, 77), (22, 300)] {
        assert_eq!(
            (w.monster(mid).current_hp, w.monster_pub(mid).current_hp),
            (hp, hp),
            "monster {mid}: its unit's HP is written back"
        );
    }
    let s = summary(&w, live.id);
    assert_eq!(
        (s.kind, s.outcome, s.end_how),
        (
            BattleKind::Pvp,
            BattleOutcome::SideBWins,
            Some(EndHow::Forfeit)
        )
    );
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(b()), Some((win, 1, 0)));
    assert_eq!(w.profile(a()), Some((lose, 0, 1)));
    let gcs: Vec<spacetimedb::ScheduleAt> =
        w.gcs_of(live.id).iter().map(|r| r.scheduled_at).collect();
    assert_eq!(gcs, vec![time(t + DAY_MS)], "exactly one GC row");
    assert!(w.deadlines_of(live.id).is_empty(), "no window outlives it");
    let before = w.snapshot();
    for who in [a(), b()] {
        assert_eq!(
            forfeit(&fx, who, t + 1_000, live.id),
            Err("battle is not ongoing".to_string()),
            "{who}: a finished battle cannot be forfeited again"
        );
    }
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "nothing moves again: rated once"
    );
}

/// B's forfeit maps to `SideAWins` (the forfeiter's OPPONENT wins), and A is the rated winner.
///
/// WRONG IMPL KILLED: a forfeit outcome hard-wired to `SideBWins` (side A's mapping reused); the
/// sender's side read off `player_identity` only.
#[test]
fn forfeit_by_side_b_ends_side_a_wins_and_rates_side_a_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    assert_eq!(forfeit(&fx, b(), T0 + 9_000, live.id), Ok(()));
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideAWins);
    assert_eq!(
        battle_ends(&w, live.id),
        vec![BattleEndEvent {
            outcome: BattleOutcome::SideAWins,
            how: EndHow::Forfeit
        }]
    );
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(a()), Some((win, 1, 0)));
    assert_eq!(w.profile(b()), Some((lose, 0, 1)));
}

/// B's disconnect on an Active PvP battle is B's forfeit: A wins, rated; B's READY row deleted, never
/// executed. A third identity's disconnect changes nothing, and the carried
/// `pvp::forfeit_on_disconnect` that runs after it settles (rates) nothing a second time.
///
/// WRONG IMPL KILLED: the freeze (the resolver only knows wild anchors: the PvP battle stays live
/// until the legacy forfeit settles it through the 1v1 write-back); a PvP disconnect auto-fled
/// (`Fled`, unrated); the opponent-role anchor not found (only `player_identity` scanned); a second
/// rating through the legacy path.
#[test]
fn a_disconnect_of_side_b_on_an_active_pvp_battle_forfeits_like_the_reducer_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    submit(
        &fx,
        b(),
        T0 + 8_000,
        live.id,
        live.b[0],
        vec![QueuedAction::EndTurn],
    )
    .expect("B pre-queues its first unit");
    w.join(c(), 3);
    let before = w.snapshot();
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(T0 + 8_500)), c());
    assert_eq!(
        changed(&before, &w.snapshot()),
        none(),
        "a stranger's disconnect touches nothing"
    );
    let t = T0 + 9_000;
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t)), b());
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideAWins);
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    assert_eq!(
        battle_ends(&w, live.id),
        vec![BattleEndEvent {
            outcome: BattleOutcome::SideAWins,
            how: EndHow::Forfeit
        }]
    );
    assert_voided_unexecuted(&w, live.id, live.b[0], "disconnect");
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(a()), Some((win, 1, 0)));
    assert_eq!(w.profile(b()), Some((lose, 0, 1)));
    assert_eq!(summary(&w, live.id).end_how, Some(EndHow::Forfeit));
    let after = w.snapshot();
    crate::pvp::forfeit_on_disconnect(&fx.ctx_at(at(t + 1_000)), b());
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t + 2_000)), b());
    assert_eq!(
        changed(&after, &w.snapshot()),
        none(),
        "already terminal: no second settle, no second rating"
    );
}

/// A disconnect during Deploying cancels the battle with NO rating change: anchor `Fled`, phase
/// Finished, staging rows gone, no unit, no monster row touched, the summary `Fled` with no
/// `end_how` (no `BattleEnd` was ever emitted), both players released.
///
/// WRONG IMPL KILLED: a Deploying disconnect rated as a forfeit (a player who never saw the board
/// loses rating); the opponent-role Deploying anchor left live; staging rows left behind.
#[test]
fn a_disconnect_during_deploying_cancels_the_pvp_battle_unrated_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let id = deploying_pvp(&fx, &w, &PAIR, &B_PAIR, 2);
    deploy(&fx, a(), T0 + 2_000, id, vec![pick(11, 0), pick(12, 1)]).expect("A locks");
    let party = (row_set(&w.monsters.rows()), row_set(&w.pubs.rows()));
    let t = T0 + 10_000;
    crate::tactics::resolve_tactical_on_disconnect(&fx.ctx_at(at(t)), b());
    assert_eq!(outcome(&w, id), BattleOutcome::Fled);
    assert_eq!(w.tactical(id).phase, Phase::Finished);
    assert!(w.deploys_of(id).is_empty(), "the staging rows are gone");
    assert!(w.units_of(id).is_empty(), "nothing was revealed");
    assert!(w.profiles.rows().is_empty(), "a cancel rates nobody");
    assert_eq!(
        (row_set(&w.monsters.rows()), row_set(&w.pubs.rows())),
        party,
        "a Deploying close writes no monster row"
    );
    let s = summary(&w, id);
    assert_eq!((s.outcome, s.end_how), (BattleOutcome::Fled, None));
    for who in [a(), b()] {
        assert!(!crate::guards::is_in_ongoing_battle(&fx.ctx(), who));
    }
}

/// The lib.rs `on_disconnect` bundle reaches the tactical PvP forfeit: B's LAST session leaving ends
/// the battle `SideAWins` by `Forfeit`, rated.
///
/// WRONG IMPL KILLED: a resolver wired into `resolve_tactical_on_disconnect` but never reached from
/// `on_disconnect` (or reached only after the legacy forfeit already settled the anchor 1v1).
#[test]
fn on_disconnect_of_the_last_session_reaches_the_tactical_pvp_forfeit_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    w.sessions.seed(&crate::schema::PlayerSession {
        connection_id: spacetimedb::ConnectionId::from_u128(CONN_B),
        identity: b(),
    });
    let b_entity = w
        .players
        .rows()
        .into_iter()
        .find(|p| p.identity == b())
        .expect("b joined")
        .entity_id;
    let stood = w
        .characters
        .rows()
        .into_iter()
        .find(|c| c.entity_id == b_entity)
        .expect("b's character");
    fx.run_as_conn_at(b(), CONN_B, None, at(T0 + 9_000), crate::on_disconnect);
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideAWins);
    assert_eq!(
        battle_ends(&w, live.id),
        vec![BattleEndEvent {
            outcome: BattleOutcome::SideAWins,
            how: EndHow::Forfeit
        }]
    );
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(a()), Some((win, 1, 0)));
    assert_eq!(w.profile(b()), Some((lose, 0, 1)));
    let saved: Vec<(Identity, u32, i32, i32)> = w
        .last_positions
        .rows()
        .iter()
        .map(|p| (p.owner_identity, p.zone_id, p.tile_x, p.tile_y))
        .collect();
    assert_eq!(
        saved,
        vec![(b(), stood.zone_id, stood.tile_x, stood.tile_y)],
        "a PvP forfeit by disconnect saves the leaver's tile, and only the leaver's"
    );
    assert!(
        w.characters
            .rows()
            .iter()
            .any(|c| c.entity_id != stood.entity_id),
        "the opponent's character stays"
    );
}

/// Surge (PvP only): round 9's upkeep takes `max(1, max_hp * 5 * (9 - 8) / 100)` from EVERY living
/// unit of both sides — 15 of 300 — as one `Surge{round 9}` event each.
///
/// WRONG IMPL KILLED: a PvP battle hydrated as `Wild` (no Surge, the match never terminates); Surge
/// on one side only; the PvE round cap.
#[test]
fn surge_from_round_nine_strikes_every_living_pvp_unit_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    let all: Vec<u32> = live.a.iter().chain(&live.b).copied().collect();
    pvp_boundary(&w, live.id, 9, &all);
    let t = T0 + 50_000;
    for (who, units) in [(a(), &live.a), (b(), &live.b)] {
        for &unit in units {
            submit(&fx, who, t, live.id, unit, vec![QueuedAction::EndTurn])
                .expect("a pre-queue at the boundary");
        }
    }
    run_round(&fx, &w, live.id, 9, t);
    let want = u16::try_from(300u32 * 5 / 100).expect("small");
    assert_eq!(want, 15, "PRECONDITION: 5% of 300");
    let mut surges: Vec<(u32, u16, u16)> = w
        .events_of(live.id)
        .into_iter()
        .filter_map(|e| match e.payload {
            EventPayload::Surge(s) => Some((s.unit, s.round, s.amount)),
            _ => None,
        })
        .collect();
    surges.sort_unstable();
    let mut expected: Vec<(u32, u16, u16)> = all.iter().map(|&u| (u, 9, want)).collect();
    expected.sort_unstable();
    assert_eq!(surges, expected, "one Surge per living unit of both sides");
    for &unit in &all {
        assert_eq!(
            w.unit(unit).cur_hp,
            300 - want,
            "unit {unit} lost the Surge"
        );
    }
}

/// Both sides emptied by the same upkeep step (Surge kills all four) end by the adjudication tuple:
/// A's units stood at 10 of 300 (3% each) and B's at 1 (0%), so A wins on HP percent —
/// `BattleEnd{SideAWins, AdjudicatedHpPercent}` — never `Fled` or a draw; the result is rated, and the
/// summary records the reason (`end_how`) and the four KOs after round 1 (`kos_after_r1`).
///
/// WRONG IMPL KILLED: a mutual wipe closed as `Fled` / left `Ongoing`; the adjudication reason not
/// recorded in `battle_summary`; `kos_after_r1` not counted (both sides' KOs in rounds > 1); an
/// unrated adjudicated win.
#[test]
fn a_mutual_surge_wipe_is_adjudicated_rated_and_recorded_in_the_summary_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    let all: Vec<u32> = live.a.iter().chain(&live.b).copied().collect();
    pvp_boundary(&w, live.id, 9, &all);
    for &unit in &live.a {
        w.edit_unit(unit, |u| u.cur_hp = 10);
    }
    for &unit in &live.b {
        w.edit_unit(unit, |u| u.cur_hp = 1);
    }
    let t = T0 + 50_000;
    for (who, units) in [(a(), &live.a), (b(), &live.b)] {
        for &unit in units {
            submit(&fx, who, t, live.id, unit, vec![QueuedAction::EndTurn])
                .expect("a pre-queue at the boundary");
        }
    }
    run_round(&fx, &w, live.id, 9, t);
    assert_eq!(
        battle_ends(&w, live.id),
        vec![BattleEndEvent {
            outcome: BattleOutcome::SideAWins,
            how: EndHow::AdjudicatedHpPercent
        }],
        "A held more HP percent at the start of the step"
    );
    for &unit in &all {
        assert_eq!(
            w.unit(unit).state,
            UnitState::Fainted,
            "PRECONDITION: unit {unit} fell to the Surge"
        );
    }
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideAWins);
    let s = summary(&w, live.id);
    assert_eq!(
        (s.outcome, s.end_how, s.kos_after_r1),
        (
            BattleOutcome::SideAWins,
            Some(EndHow::AdjudicatedHpPercent),
            4
        ),
        "the summary carries the adjudication reason and the denominator"
    );
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(a()), Some((win, 1, 0)));
    assert_eq!(w.profile(b()), Some((lose, 0, 1)));
    for mid in [11u64, 12, 21, 22] {
        assert_eq!(
            w.monster(mid).current_hp,
            0,
            "monster {mid}: HP written back"
        );
    }
}

/// A wild battle never Surges: round 9's upkeep on a `live_pair` runs (RoundEnded{9}) with no Surge.
///
/// WRONG IMPL KILLED: a shell that hydrates every battle under the PvP ruleset.
#[test]
fn a_wild_battle_never_surges_bt14_5() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    boundary(&w, live.id, 9, &[live.u1, live.u2, live.wild]);
    let t = T0 + 50_000;
    for unit in [live.u1, live.u2] {
        submit(&fx, a(), t, live.id, unit, vec![QueuedAction::EndTurn])
            .expect("a pre-queue at the boundary");
    }
    run_round(&fx, &w, live.id, 9, t);
    let events = w.events_of(live.id);
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::RoundEnded(r) if r.round == 9)),
        "non-vacuous: round 9's upkeep ran"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::Surge(_))),
        "a wild battle never Surges"
    );
}

// ---------------------------------------------------------------------------
// BT14.6 — the settle mapping: rating unchanged, no XP, no currency, symmetric essence, Practice
// ---------------------------------------------------------------------------

/// A PvP settle with a KO each way: each KILLER's monster gains `essence_battle_reward(victim BST)`
/// in the VICTIM's affinity pool — A's killer and B's killer alike — and nothing else is paid: no
/// monster's XP or level moves, no wallet is credited, no `Awards` line carries XP or currency. The
/// rating is the carried M17 update.
///
/// WRONG IMPL KILLED: the 1v1 `write_back_battle_results` reused for a tactical anchor (side-A XP +
/// currency on a win, side B paid nothing — the M16a asymmetry); the ledger paid for side A only;
/// essence into the killer's own affinity; XP from the wild split; a second rating caller.
#[test]
fn a_pvp_settle_pays_each_killer_the_victims_essence_and_no_xp_or_currency_bt14_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    let before: Vec<Monster> = [11u64, 12, 21, 22].iter().map(|&m| w.monster(m)).collect();
    // A's 11 KOs B's 22, A's 12 passes, B's 21 KOs A's 12.
    pvp_ko(&fx, &w, live.id, a(), live.a[0], live.b[1], T0 + 10_000);
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.a[1])
    );
    submit(
        &fx,
        a(),
        T0 + 12_000,
        live.id,
        live.a[1],
        vec![QueuedAction::EndTurn],
    )
    .expect("A's second unit ends its turn");
    assert_eq!(
        w.tactical(live.id).turn_state,
        TurnState::Waiting(live.b[0])
    );
    pvp_ko(&fx, &w, live.id, b(), live.b[0], live.a[1], T0 + 14_000);
    assert_eq!(forfeit(&fx, a(), T0 + 20_000, live.id), Ok(()));
    assert_eq!(outcome(&w, live.id), BattleOutcome::SideBWins);

    let (ess_22, ess_12) = (essence_battle_reward(bst(1)), essence_battle_reward(bst(3)));
    assert!(ess_22 > 0 && ess_12 > 0, "non-vacuous: a KO pays essence");
    let after: Vec<Monster> = [11u64, 12, 21, 22].iter().map(|&m| w.monster(m)).collect();
    assert_eq!(
        pools(&after[0]),
        pools_plus(&before[0], affinity_of(1), ess_22),
        "A's killer (11) gains the victim's (22, species 1) essence in its affinity"
    );
    assert_eq!(
        pools(&after[2]),
        pools_plus(&before[2], affinity_of(3), ess_12),
        "B's killer (21) gains the victim's (12, species 3) essence symmetrically"
    );
    for i in [1usize, 3] {
        assert_eq!(
            pools(&after[i]),
            pools(&before[i]),
            "monster {} killed nobody: no essence",
            after[i].monster_id
        );
    }
    for (b4, now) in before.iter().zip(&after) {
        assert_eq!(
            (now.xp, now.level),
            (b4.xp, b4.level),
            "monster {}: no XP in PvP",
            now.monster_id
        );
    }
    assert!(
        w.wallets.rows().iter().all(|r| r.balance == 0),
        "no currency for either player"
    );
    let lines: Vec<AwardsEvent> = awards_after_end(&w, live.id)
        .into_iter()
        .map(|(_, x)| x)
        .collect();
    assert!(
        lines.iter().all(|x| x.xp == 0 && x.currency == 0),
        "no Awards line carries XP or currency: {lines:?}"
    );
    let mut paid: Vec<(u32, u32)> = lines
        .iter()
        .filter(|x| x.unit != CURRENCY_AWARD_UNIT)
        .map(|x| (x.unit, x.essence))
        .collect();
    paid.sort_unstable();
    let mut want = vec![(live.a[0], ess_22), (live.b[0], ess_12)];
    want.sort_unstable();
    assert_eq!(paid, want, "one essence line per killer, both sides");
    let (win, lose) = first_game_ratings();
    assert_eq!(w.profile(b()), Some((win, 1, 0)));
    assert_eq!(w.profile(a()), Some((lose, 0, 1)));
}

/// Practice (self vs self, disjoint side lists) settles under the PvP ruleset with no rating and no
/// rewards — no essence even for a KO, no XP, no currency, no `Awards` line — while the HP of BOTH
/// lists is still written back. Both stagings come from the one player (side A, then side B).
///
/// WRONG IMPL KILLED: a Practice battle rated (`is_ranked_pvp` bypassed); the PvP essence paid in
/// Practice; side B's list never written back (a self-battle that heals one half of the party); the
/// second stage call refused as "already locked".
#[test]
fn a_practice_settle_rates_and_rewards_nothing_but_writes_back_both_lists_hp_bt14_6() {
    let fx = fixture();
    let w = world(&fx);
    w.join(a(), 1);
    w.seed_party(a(), &QUAD);
    let id = start_pvp(&fx, a(), &[11, 12], a(), &[13, 14], 2, pvp_seed(7), T0);
    assert_eq!(w.tactical(id).kind, BattleKind::Practice);
    deploy(&fx, a(), T0 + 2_000, id, vec![pick(11, 0), pick(12, 1)]).expect("side A staged");
    deploy(&fx, a(), T0 + 3_000, id, vec![pick(13, 0), pick(14, 1)])
        .expect("side B staged: the reveal");
    let side = |s: SideRow| -> Vec<u32> { w.side_units(id, s).iter().map(|u| u.unit_id).collect() };
    let (ua, ub) = (side(SideRow::A), side(SideRow::B));
    assert_eq!(
        (ua.len(), ub.len()),
        (2, 2),
        "PRECONDITION: both sides deployed"
    );
    let before: Vec<Monster> = [11u64, 12, 13, 14].iter().map(|&m| w.monster(m)).collect();
    pvp_ko(&fx, &w, id, a(), ua[0], ub[1], T0 + 10_000);
    w.edit_unit(ua[1], |u| u.cur_hp = 111);
    w.edit_unit(ub[0], |u| u.cur_hp = 99);
    assert_eq!(forfeit(&fx, a(), T0 + 20_000, id), Ok(()));
    assert_ne!(
        outcome(&w, id),
        BattleOutcome::Ongoing,
        "PRECONDITION: ended"
    );
    assert!(w.profiles.rows().is_empty(), "Practice never rates");
    assert!(
        !w.events_of(id)
            .iter()
            .any(|e| matches!(&e.payload, EventPayload::Awards(_))),
        "Practice pays no Awards line"
    );
    assert!(
        w.wallets.rows().iter().all(|r| r.balance == 0),
        "no currency"
    );
    for (b4, mid) in before.iter().zip([11u64, 12, 13, 14]) {
        let now = w.monster(mid);
        assert_eq!(
            (now.xp, now.level, pools(&now)),
            (b4.xp, b4.level, pools(b4)),
            "monster {mid}: no XP, no essence in Practice"
        );
    }
    for (mid, hp) in [(11u64, 300u16), (12, 111), (13, 99), (14, 0)] {
        assert_eq!(
            w.monster(mid).current_hp,
            hp,
            "monster {mid}: both lists' HP is written back"
        );
    }
    assert_eq!(summary(&w, id).kind, BattleKind::Practice);
}

/// Recruit and Flee are refused at the submit gate under the PvP ruleset — live (the waiting unit)
/// and pre-queued, for either player — with the engine's typed `NotInPvp`, writing nothing.
///
/// WRONG IMPL KILLED: a PvP battle hydrated as `Wild` (a Flee ends a rated match as `Fled`; a Recruit
/// steals the opponent's monster).
#[test]
fn recruit_and_flee_are_refused_at_the_pvp_submit_gate_live_and_prequeued_bt14_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
    let before = w.snapshot();
    let cases: [(&str, Identity, u32); 3] = [
        ("A live", a(), live.a[0]),
        ("A pre-queued", a(), live.a[1]),
        ("B pre-queued", b(), live.b[0]),
    ];
    for (label, who, unit) in cases {
        let foe = if who == a() { live.b[0] } else { live.a[0] };
        for (entry, want) in [
            (QueuedAction::Flee, "submit_queue: NotInPvp(Flee)"),
            (recruit(foe, None), "submit_queue: NotInPvp(Recruit)"),
        ] {
            assert_eq!(
                submit(&fx, who, T0 + 9_000, live.id, unit, vec![entry]),
                Err(want.to_string()),
                "{label}"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                none(),
                "{label}: nothing written"
            );
        }
    }
}

/// `step_delta` counts `kos_after_r1` — every `Ko` of either side in a round after the first — and
/// `apply_delta` adds it, saturating.
///
/// WRONG IMPL KILLED: the freeze (the counter never counted); round 1 counted; only player-side or
/// only super-effective KOs counted (that is `se_kos_after_r1`); a wrapping add.
#[test]
fn step_delta_counts_kos_after_round_one_and_apply_delta_saturates_them_bt14_6() {
    let kos = |round: u16, events: Vec<EventPayload>| {
        step_delta(&prev(Some(P1), 1, &[]), &step_of(round, events), &PLAYERS).kos_after_r1
    };
    assert_eq!(
        kos(
            2,
            vec![
                hit(P1, WILD, 50, true),
                ko(WILD),
                hit(WILD, P2, 50, true),
                ko(P2)
            ]
        ),
        2,
        "round 2: both sides' KOs"
    );
    assert_eq!(
        kos(3, vec![ko(WILD)]),
        1,
        "a KO with no hit (a tick) counts"
    );
    assert_eq!(
        kos(1, vec![hit(P1, WILD, 50, true), ko(WILD)]),
        0,
        "never in round 1"
    );
    assert_eq!(kos(4, vec![hit(P1, WILD, 5, false)]), 0, "no KO, no count");
    let mut row = zero_summary(42, a(), BattleOutcome::Ongoing);
    row.kos_after_r1 = 3;
    let got = apply_delta(
        row,
        &StepDelta {
            kos_after_r1: 2,
            ..StepDelta::default()
        },
    );
    assert_eq!(got.kos_after_r1, 5, "added");
    let mut row = zero_summary(42, a(), BattleOutcome::Ongoing);
    row.kos_after_r1 = u16::MAX - 1;
    let got = apply_delta(
        row,
        &StepDelta {
            kos_after_r1: 5,
            ..StepDelta::default()
        },
    );
    assert_eq!(got.kos_after_r1, u16::MAX, "saturating");
}

/// An anchor-less finish (the anchor already gone when a deadline fires) finalises the battle's
/// summary row `Fled` — never left `Ongoing` — with its rounds, no wall time and no `end_how`.
///
/// WRONG IMPL KILLED: the freeze (`finalize_orphan_summary` a no-op: the row reads `Ongoing` for
/// ever and poisons the H1/H2 telemetry).
#[test]
fn an_anchorless_finish_finalises_its_summary_as_fled_bt14_6() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    assert_eq!(
        summary(&w, live.id).outcome,
        BattleOutcome::Ongoing,
        "PRECONDITION: the Active start wrote the summary row"
    );
    let window = w.only_deadline(live.id);
    let deadline = w.clock(live.id).deadline_ms.expect("an open window");
    assert_eq!(w.battles.remove(live.id), 1, "the anchor is gone");
    assert_eq!(fire_deadline(&fx, deadline, deadline_args(&window)), Ok(()));
    assert_eq!(w.tactical(live.id).phase, Phase::Finished);
    let s = summary(&w, live.id);
    assert_eq!(
        (s.outcome, s.rounds, s.wall_ms, s.end_how),
        (BattleOutcome::Fled, w.tactical(live.id).round, 0, None),
        "finalised Fled, never Ongoing"
    );
}

// ---- settle log lines are observable events: a log sink asserts them (nextest runs each test in its own process, so installing the global logger once per test is safe, as in the crate's other sinks) ----
struct SettleLogSink(std::sync::Mutex<Vec<String>>);
impl log::Log for SettleLogSink {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(record.args().to_string());
    }
    fn flush(&self) {}
}
static SETTLE_LOGS: SettleLogSink = SettleLogSink(std::sync::Mutex::new(Vec::new()));
fn install_log_sink() {
    log::set_logger(&SETTLE_LOGS).expect("nextest");
    log::set_max_level(log::LevelFilter::Info);
}
fn captured_log_lines(needle: &str) -> Vec<String> {
    SETTLE_LOGS
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|l| l.contains(needle))
        .cloned()
        .collect()
}

#[test]
fn unattributed_ko_logs_ledger_skip() {
    install_log_sink();
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    ready_ko(&w, &live);
    ko_submit(&fx, &w, &live, T0 + 25_000);
    let skip = captured_log_lines("tactical_ledger_skip");
    assert_eq!(skip.len(), 1, "{skip:?}");
    assert!(
        skip[0].contains(&format!("\"unattributed\":[{}]", live.u2)),
        "{skip:?}"
    );
    assert!(captured_log_lines("tactical_ledger_mismatch").is_empty());
}

#[test]
fn fall_without_ko_logs_mismatch() {
    install_log_sink();
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    w.edit_unit(live.u2, |u| {
        u.cur_hp = 0;
        u.state = UnitState::Fainted;
    });
    w.edit_tactical(live.id, |t| t.initiative.retain(|&x| x != live.u2));
    ready_ko(&w, &live);
    ko_submit(&fx, &w, &live, T0 + 25_000);
    let mm = captured_log_lines("tactical_ledger_mismatch");
    assert_eq!(mm.len(), 1, "{mm:?}");
    assert!(
        mm[0].contains(&format!("\"fainted_without_ko\":[{}]", live.u2)),
        "{mm:?}"
    );
    assert!(captured_log_lines("tactical_ledger_skip").is_empty());
}

#[test]
fn failed_writeback_logs_skipped() {
    install_log_sink();
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    ready_ko(&w, &live);
    w.edit_monster(12, |m| m.owner_identity = b());
    ko_submit(&fx, &w, &live, T0 + 25_000);
    let l = captured_log_lines("tactical_settle_skipped");
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].contains("HP write-back failed"), "{l:?}");
}

/// A recruit pre-queued by u1 that pops at the ROUND BOUNDARY runs inside the scheduled
/// `tactical_advance`, i.e. under the MODULE sender — and the recruited monster still belongs to
/// the player who queued it. Every other recruit-success test resolves under the owner's own
/// submit, where the owner and `ctx.sender()` coincide.
///
/// Survivor ("the recruit lands with its owner") of `taming_tests::nh_recruit_success_spends_bait_boxes_the_wild_and_grants_no_xp`,
/// deleted by bt-17.
///
/// kills: the recruit insert owned by `ctx.sender()` instead of the unit's owner (the module
/// identity would own the recruit).
#[test]
fn a_prequeued_recruit_popped_by_a_round_advance_is_owned_by_the_player_bt17_2() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    seat_between(&w, &live);
    give(&w, 1, 2);
    let pct = odds_pct(&w, live.wild, Some(1));
    submit(
        &fx,
        a(),
        T0 + 10_000,
        live.id,
        live.u1,
        vec![QueuedAction::EndTurn],
    )
    .expect("u1 ends its live turn");
    submit(
        &fx,
        a(),
        T0 + 11_000,
        live.id,
        live.u1,
        vec![recruit(live.wild, Some(1))],
    )
    .expect("u1 pre-queues a recruit for the next round");
    submit(
        &fx,
        a(),
        T0 + 12_000,
        live.id,
        live.u2,
        vec![QueuedAction::EndTurn],
    )
    .expect("u2 ends its turn: the round closes");
    force_recruit(&w, live.id, pct, true);
    for adv in w.advances_of(live.id) {
        fire_advance(&fx, T0 + 13_000, advance_args(&adv)).expect("the boundary fire is Ok");
    }
    let got = new_monsters(&w);
    assert_eq!(
        got.len(),
        1,
        "PRECONDITION: the pre-queued recruit popped at the boundary and succeeded"
    );
    assert_eq!(
        got[0].owner_identity,
        a(),
        "the recruit belongs to the player who queued it, never the module sender"
    );
}

/// A PvP settle pays nothing when EITHER side's HP write-back fails: with a KO on the ledger (A's 11
/// over B's 22, which a healthy settle pays in essence) and one party monster handed to a third
/// identity before the forfeit — A's 12, then B's 21 — the battle still ends, the killer's pools
/// are unmoved, no `Awards` line is written and the skip is logged once.
///
/// kills: `replace && with || in settle_pvp_battle` (one healthy side vouching for the other: the
/// ledger is paid although a write-back aborted).
#[test]
fn a_pvp_settle_with_one_sides_hp_write_back_failed_pays_nothing() {
    install_log_sink();
    for (handed_away, label) in [(12u64, "side A's"), (21, "side B's")] {
        let fx = fixture();
        let w = world(&fx);
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        pvp_ko(&fx, &w, live.id, a(), live.a[0], live.b[1], T0 + 10_000);
        assert!(
            essence_battle_reward(bst(1)) > 0,
            "non-vacuous: the KO of 22 (species 1) pays essence on a healthy settle"
        );
        let killer = w.monster(11);
        w.edit_monster(handed_away, |m| m.owner_identity = c());
        let skipped = captured_log_lines("tactical_settle_skipped").len();

        assert_eq!(forfeit(&fx, a(), T0 + 20_000, live.id), Ok(()), "{label}");
        assert_eq!(
            outcome(&w, live.id),
            BattleOutcome::SideBWins,
            "{label} write-back failed: the battle still ends"
        );
        assert_eq!(
            captured_log_lines("tactical_settle_skipped").len(),
            skipped + 1,
            "{label} write-back failed: the settlement took the logged skip path once"
        );
        assert_eq!(
            pools(&w.monster(11)),
            pools(&killer),
            "{label} write-back failed: the killer is paid no essence"
        );
        assert!(
            !w.events_of(live.id)
                .iter()
                .any(|e| matches!(&e.payload, EventPayload::Awards(_))),
            "{label} write-back failed: no Awards line"
        );
    }
}

// ===========================================================================
// A tactical win's level-up: stat recompute, heal, auto-evolve (R-bt-17-SETTLEFAILPATHS)
// ===========================================================================

/// The monster's HP the unit carries into the finishing KO — below every max HP in play.
const LEVEL_UP_PRE_HP: u16 = 2;
/// The XP the killer is short of the next level before the win (any award at all crosses it).
const LEVEL_UP_XP_SHORT: u32 = 1;
/// A level-5 monster 11 (the fixture's level) is about to reach level 6.
const LEVEL_UP_FROM: u8 = 5;

fn six_of_row(m: &Monster) -> [u16; 6] {
    [
        m.stat_hp,
        m.stat_attack,
        m.stat_defense,
        m.stat_speed,
        m.stat_sp_attack,
        m.stat_sp_defense,
    ]
}

fn six_of_block(s: &StatBlock) -> [u16; 6] {
    [
        s.hp,
        s.attack,
        s.defense,
        s.speed,
        s.sp_attack,
        s.sp_defense,
    ]
}

/// The row's individuality run through `derive_stats` at `lvl` over `base` — what a level-up (or
/// an evolution onto `base`'s species) must write.
fn derived_for(m: &Monster, base: &StatBlock, lvl: u8) -> StatBlock {
    let ivs = game_core::IVs::new(
        m.iv_hp,
        m.iv_attack,
        m.iv_defense,
        m.iv_speed,
        m.iv_sp_attack,
        m.iv_sp_defense,
    )
    .expect("the fixture's IVs are valid");
    let evs = game_core::EVs::new(
        m.ev_hp,
        m.ev_attack,
        m.ev_defense,
        m.ev_speed,
        m.ev_sp_attack,
        m.ev_sp_defense,
    )
    .expect("the fixture's EVs are valid");
    game_core::derive_stats(
        base,
        &ivs,
        &evs,
        &game_core::Nature::new(m.nature_kind),
        level(lvl),
    )
}

/// What one levelling tactical win left behind.
struct LevelUpRun {
    /// Monster 11 as the finishing KO found it (level 5, one XP short of 6, stats sentinel).
    pre: Monster,
    /// Monster 11 after the whole settle.
    post: Monster,
    /// Its `monster_pub` species after the settle.
    pub_species: u32,
    /// The ledger's XP award to its unit.
    xp_gain: u32,
    /// The anchor's side-A max HP for it — the `old_max_hp` `credit_monster` heals against.
    old_max_hp: u16,
    /// Every queued reveal as `(monster_id, from_species, to_species)`.
    reveals: Vec<(u64, u32, u32)>,
}

/// A pack-1 wild win by monster 11 (u2 fell first, so 11 alone earns) from a fresh fixture:
/// 11 is a real level-5 monster one XP short of level 6 at `LEVEL_UP_PRE_HP` HP, its five non-HP
/// stats are sentinels no `derive_stats` value reaches, and the anchor's side-A max HP for it is
/// its real level-5 max HP, so a level-up grows the max and heals exactly the growth. With
/// `edge_to = Some((species, min_level))` one level-only edge out of its species is seeded.
fn level_up_win(edge_to: Option<(u32, u8)>) -> LevelUpRun {
    let fx = fixture();
    let w = world(&fx);
    let species_rows = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    let paths = fx
        .table_keyed::<crate::schema::EvolutionPathRow, u64>("evolution_path", "path_id", |r| {
            r.path_id
        })
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.path_id, |r, id| r.path_id = id);
    let notices = fx
        .table::<crate::schema::PendingEvolutionNotice>(
            "pending_evolution_notice",
            "owner_identity",
            |r| r.owner_identity,
        )
        .writable()
        .unique();
    if let Some((to_species, min_level)) = edge_to {
        species_rows.seed(&species_row_of(&species_def(to_species)));
        paths.seed(&crate::schema::EvolutionPathRow {
            path_id: 1,
            edge_id: 1,
            from_species: w_species_of_11(),
            to_species,
            min_level,
            essence: vec![],
            min_trust_tier: None,
            min_quality_time_tier: None,
            min_nutrition_pct: None,
        });
    }
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    ready_ko(&w, &live);
    let wild_species = w.unit(live.wild).species_id;

    let real = w.monster(11);
    let species = species_def(real.species_id);
    let old_max_hp = derived_for(&real, &species.base_stats, LEVEL_UP_FROM).hp;
    let next_level_xp = game_core::xp_for_level(level(LEVEL_UP_FROM + 1)).value();
    w.edit_monster(11, |m| {
        m.level = LEVEL_UP_FROM;
        m.xp = next_level_xp - LEVEL_UP_XP_SHORT;
        m.stat_hp = old_max_hp;
        m.stat_attack = 701;
        m.stat_defense = 702;
        m.stat_speed = 703;
        m.stat_sp_attack = 704;
        m.stat_sp_defense = 705;
        m.current_hp = LEVEL_UP_PRE_HP;
    });
    w.edit_unit(live.u1, |u| u.cur_hp = LEVEL_UP_PRE_HP);
    let mut anchor = w.anchor(live.id).expect("the anchor exists");
    let i = anchor
        .party_monster_ids
        .iter()
        .position(|&m| m == 11)
        .expect("monster 11 is in the party");
    anchor.state.side_a.team[i].max_hp = old_max_hp;
    assert_eq!(w.battles.remove(live.id), 1, "the anchor edited in place");
    w.battles.seed(&anchor);
    let pre = w.monster(11);

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
    let award = payout
        .awards
        .iter()
        .find(|aw| aw.unit == live.u1)
        .expect("the killer's unit is paid");
    LevelUpRun {
        pre,
        post: w.monster(11),
        pub_species: w.monster_pub(11).species_id,
        xp_gain: award.xp,
        old_max_hp,
        reveals: notices
            .rows()
            .into_iter()
            .flat_map(|n| n.entries)
            .map(|e| (e.monster_id, e.from_species, e.to_species))
            .collect(),
    }
}

/// The species monster 11 holds in `PAIR` (read off the spec, not the row, because the evolution
/// edge is seeded before the battle's rows exist).
fn w_species_of_11() -> u32 {
    PAIR.iter()
        .find(|&&(id, ..)| id == 11)
        .map(|&(_, species, ..)| species)
        .expect("monster 11 is in PAIR")
}

/// A tactical win whose award carries the killer over a level boundary: the level-up writes the
/// stats `derive_stats` gives for the new level, heals the max-HP growth (`level_up_healed_hp`
/// against the anchor's battle-time max), and the unconditional evolution check then applies the
/// one level-only edge the new level makes eligible. Two runs from fresh fixtures separate the
/// steps: without an edge the level-up is observable on its own (species unchanged); with the edge
/// the evolved species, its re-derived stats, its clamped HP, the zeroed essence and the one reveal
/// are observable, and the edge's `min_level` is the post-win level, so the check can only fire
/// AFTER the level-up.
///
/// kills: the six `stat_*` writes deleted from `battle::credit_monster` (run 1: the stats stay
/// the sentinels); the `current_hp = level_up_healed_hp(..)` line deleted (run 1: HP stays at
/// `LEVEL_UP_PRE_HP`; run 2: the clamped HP is that too); the `check_and_evolve(ctx, mid)` call
/// deleted (run 2: the species stays and no reveal is queued).
#[test]
fn a_tactical_win_that_levels_a_monster_up_recomputes_stats_heals_and_auto_evolves() {
    // Run 1 — no edge: the level-up alone.
    let run = level_up_win(None);
    let (pre, post) = (&run.pre, &run.post);
    let species = species_def(pre.species_id);
    assert!(run.xp_gain > 0, "PRECONDITION: the win pays XP");
    let (want_xp, want_level) = after_gain(pre.xp, run.xp_gain);
    assert!(
        want_level > pre.level,
        "PRECONDITION: the award crosses a level boundary ({} -> {want_level})",
        pre.level
    );
    assert_eq!(
        (post.xp, post.level),
        (want_xp, want_level),
        "the killer gains exactly the ledger's XP"
    );
    let derived = derived_for(pre, &species.base_stats, want_level);
    assert!(
        derived.hp > run.old_max_hp,
        "PRECONDITION: the level-up grows max HP, so a heal is owed"
    );
    assert!(
        six_of_block(&derived)
            .iter()
            .zip(six_of_row(pre))
            .all(|(d, p)| *d != p),
        "PRECONDITION: every sentinel stat differs from its derived value"
    );
    assert_eq!(
        six_of_row(post),
        six_of_block(&derived),
        "all six stats are recomputed for the new level from the species base"
    );
    let healed =
        game_core::combat::xp::level_up_healed_hp(LEVEL_UP_PRE_HP, run.old_max_hp, derived.hp);
    assert!(
        healed > LEVEL_UP_PRE_HP,
        "PRECONDITION: the heal is visible"
    );
    assert_eq!(
        post.current_hp, healed,
        "the HP gained from max-HP growth heals exactly its own gain"
    );
    assert_eq!(post.species_id, pre.species_id, "no edge: no evolution");
    assert_eq!(run.pub_species, pre.species_id);
    assert!(run.reveals.is_empty(), "no edge: no reveal");
    assert_ne!(
        pools(post),
        [0; 8],
        "non-vacuous: the win paid essence, which an evolution would spend"
    );

    // Run 2 — the same win with one level-only edge into species 2, eligible only from the
    // post-win level.
    let to_species = 2;
    assert_ne!(to_species, pre.species_id, "the edge changes the species");
    let evolved_run = level_up_win(Some((to_species, want_level)));
    let evolved = &evolved_run.post;
    assert_eq!(
        evolved_run.pre.level, LEVEL_UP_FROM,
        "PRECONDITION: the edge (min_level {want_level}) is not eligible before the win"
    );
    assert_eq!(
        (evolved.xp, evolved.level),
        (want_xp, want_level),
        "the same award, the same level"
    );
    assert_eq!(
        evolved.species_id, to_species,
        "the check ran after the level-up and applied the one eligible edge"
    );
    assert_eq!(evolved_run.pub_species, to_species, "the public mirror too");
    let target = species_def(to_species);
    let target_stats = derived_for(&evolved_run.pre, &target.base_stats, want_level);
    assert_eq!(
        six_of_row(evolved),
        six_of_block(&target_stats),
        "an evolution re-derives every stat from the TARGET species at the new level"
    );
    assert!(
        target_stats.hp > LEVEL_UP_PRE_HP,
        "PRECONDITION: the target's max HP leaves the healed HP observable"
    );
    assert_eq!(
        evolved.current_hp,
        healed.min(target_stats.hp),
        "the level-up heal precedes the evolution, which only clamps HP to the new max"
    );
    assert_eq!(pools(evolved), [0; 8], "an evolution spends every pool");
    assert_eq!(
        evolved_run.reveals,
        vec![(11, pre.species_id, to_species)],
        "one reveal for the one applied edge"
    );
}

/// A wild win whose HP write-back fails (monster 11, the conscious killer, is handed to another
/// player, so `write_back_party_hp` aborts at it) applies NO faint penalty either: the settlement
/// logs the skip and leaves party member 12, fainted in the anchor and still the player's, with the
/// trust it had. The non-vacuity: the same fainted member costs exactly one unfavorable trust on
/// every terminal path with a healthy write-back
/// (`every_terminal_with_a_fainted_party_member_adds_exactly_one_unfavorable_trust_bt9_3`), and the
/// fainted member's own row is the player's, so `apply_faint_penalties` WOULD bump it.
///
/// kills: `settle`'s write-back-failed arm also calling `apply_faint_penalties` (monster 12 gains
/// one unfavorable trust).
#[test]
fn a_failed_write_back_with_a_fainted_member_adds_no_unfavorable_trust() {
    let fx = fixture();
    let w = world(&fx);
    let live = live_pair(&fx, &w);
    fall_in_battle(&w, live.id, live.u2);
    ready_ko(&w, &live);
    w.edit_monster(11, |m| m.owner_identity = b());
    let anchor = w.anchor(live.id).expect("the anchor exists");
    let i = anchor
        .party_monster_ids
        .iter()
        .position(|&m| m == 12)
        .expect("monster 12 is in the party");
    assert!(
        anchor.state.side_a.team[i].is_fainted(),
        "PRECONDITION: monster 12 is fainted in the anchor"
    );
    assert_eq!(
        w.monster(12).owner_identity,
        a(),
        "PRECONDITION: the fainted member is still the player's, so a penalty would land"
    );
    let handed = enc(&w.monster(11));
    let before = w.monster(12).trust_unfavorable_count;

    ko_submit(&fx, &w, &live, T0 + 25_000);

    assert_eq!(
        enc(&w.monster(11)),
        handed,
        "PRECONDITION: the write-back aborted at the handed-away killer (nothing written, nothing paid)"
    );
    assert_eq!(wallet(&w), 0, "PRECONDITION: no currency was paid");
    assert_eq!(
        w.monster(12).trust_unfavorable_count,
        before,
        "a failed write-back applies no faint penalty"
    );
}
