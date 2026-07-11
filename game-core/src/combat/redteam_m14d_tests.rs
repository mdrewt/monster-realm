//! M14d red-team / regression tests — weather/field-state slice.
//!
//! Criterion → test mapping:
//!   RT-W14-01 (M7 regression proof-of-teeth)   → m7_regression_weather_none_byte_identical
//!   RT-W14-02 (chip KO + faint cascade)        → weather_chip_faint_cascade
//!   RT-W14-03 (chip floor at tiny HP)          → weather_chip_floor_at_tiny_hp
//!   RT-W14-04 (Earth immune to Sandstorm)      → sandstorm_immune_earth
//!   RT-W14-05 (Water immune to Hail)           → hail_immune_water
//!   RT-W14-06 (Rain has no chip)               → rain_has_no_chip
//!   RT-W14-07 (Sun has no chip)                → sun_has_no_chip
//!   RT-W14-08 (weather tick preserves until 0) → weather_tick_preserves_weather_until_zero

use crate::combat::resolve::{resolve_full_turn, resolve_turn};
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::combat::weather::{apply_weather_damage, tick_weather, WeatherEffect};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

fn make_stat_block(attack: u16, defense: u16, speed: u16) -> StatBlock {
    StatBlock {
        hp: 100,
        attack,
        defense,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_monster(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity,
        level: 5,
        current_hp: hp,
        max_hp: hp,
        stats: make_stat_block(40, 40, speed),
        known_skill_ids: vec![1],
        status: None,
    }
}

fn make_battle_state(monster_a: BattleMonster, monster_b: BattleMonster) -> BattleState {
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![monster_a],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![monster_b],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    }
}

fn always_hit_variance(a_faster: bool) -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: a_faster,
    }
}

fn no_block_status_variance() -> StatusVariance {
    StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    }
}

fn empty_status() -> BattleStatusStore {
    BattleStatusStore::new(1, 1)
}

fn fire_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    }
}

fn skills_vec() -> Vec<SkillDef> {
    vec![fire_skill()]
}

// ===========================================================================
// RT-W14-01: M7 regression proof-of-teeth (LOAD-BEARING)
//
// resolve_full_turn with weather=None, empty status store, no-blocking variance
// must produce byte-identical events to resolve_turn called directly.
//
// This is the single most critical test — it guards the additive invariant that
// M14d's weather layer introduces ZERO observable change when weather=None and
// no statuses are set.
//
// Kills:
//   - A resolve_full_turn impl that emits extra WeatherDamage/WeatherExpired
//     events when weather=None (spurious events).
//   - An impl that injects extra ActionBlocked/StatusDamage from the status
//     layer even when all status slots are None.
//   - An impl where the weather modifier (1,1) accidentally changes damage
//     (e.g. integer division 0/1 instead of 1*dmg/1).
//   - Any ordering bug in the phase pipeline that changes event sequence.
// ===========================================================================

/// THE LOAD-BEARING PROOF-OF-TEETH for M14d.
///
/// resolve_full_turn with weather=None and empty status MUST produce a Vec<BattleEvent>
/// that is == (byte-identical struct values) to the Vec returned by resolve_turn.
///
/// A SetMove replayed as a raw append lands on the wrong tile — in combat terms,
/// a weather event injected when weather=None produces an event that didn't come
/// from resolve_turn, failing the == assertion.
#[test]
fn m7_regression_weather_none_byte_identical() {
    let chart = make_type_chart();
    let variance = always_hit_variance(true); // A faster, both hit
    let sv = no_block_status_variance();

    // Identical initial states.
    let monster_a = make_monster(Affinity::Fire, 200, 80);
    let monster_b = make_monster(Affinity::Water, 200, 40);

    let mut state_direct = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut state_full = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut status = empty_status();

    // Bare resolve_turn — no status/weather layer.
    let events_direct = resolve_turn(
        &mut state_direct,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
    );

    // resolve_full_turn with empty status + weather=None (must be identical).
    let events_full = resolve_full_turn(
        &mut state_full,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    assert_eq!(
        events_full, events_direct,
        "TEETH (RT-W14-01): resolve_full_turn with weather=None and empty status must \
         produce IDENTICAL events to bare resolve_turn. \
         Any spurious WeatherDamage, WeatherExpired, ActionBlocked, or StatusDamage \
         events emitted when weather=None / statuses=None would appear here. \
         A weather_attack_modifier bug (e.g. (1,1) computed as 0/1) would alter \
         damage amounts. This is the single most important M14d regression gate."
    );
    assert_eq!(
        state_full, state_direct,
        "TEETH (RT-W14-01): resulting BattleState must be identical — weather=None \
         must not mutate state differently than bare resolve_turn. \
         Any weather phase that writes to state.weather when it starts as None fails here."
    );
}

// ===========================================================================
// RT-W14-02: Sandstorm chip on a 1-HP non-immune monster KOs it
//
// A Fire monster with current_hp=1 under Sandstorm must:
//   - Receive WeatherDamage{amount:1} (floor of 1)
//   - Faint (current_hp → 0)
//   - Emit Faint{side:SideA}
//   - Emit BattleEnd{winner:SideB} (no backup)
//   - state.outcome = SideBWins
//
// Kills: an impl that applies chip damage but never checks for KO afterward
// (leaving current_hp=0 with no Faint/BattleEnd events emitted from chip damage).
// ===========================================================================

/// Kills: an impl that applies chip damage but skips the KO check for weather chip
/// (Faint+BattleEnd events absent from chip cascade), or an impl where chip
/// damage saturates without checking faint (current_hp=0 but no Faint event).
#[test]
fn weather_chip_faint_cascade() {
    // Fire monster at 1 HP — any chip (even the floor of 1) will KO it.
    let mut dying = make_monster(Affinity::Fire, 16, 50);
    dying.current_hp = 1; // 1 HP — chip (16/16=1) will KO it exactly

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![dying], // no backup
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: Some(WeatherEffect::Sandstorm { turns_remaining: 3 }),
    };

    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    // WeatherDamage must appear
    let chip_event = events.iter().find(|e| {
        matches!(
            e,
            BattleEvent::WeatherDamage {
                side: SideId::SideA,
                amount: 1
            }
        )
    });
    assert!(
        chip_event.is_some(),
        "TEETH: Sandstorm chip on 1-HP Fire must emit WeatherDamage{{side:SideA,amount:1}}; \
         an impl skipping chip or getting the floor wrong fails here"
    );

    // Faint must appear
    let has_faint = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Faint {
                side: SideId::SideA
            }
        )
    });
    assert!(
        has_faint,
        "TEETH: Faint{{side:SideA}} must be emitted when chip brings current_hp to 0; \
         an impl that applies chip but skips the KO check fails here"
    );

    // BattleEnd must appear (no backup for SideA → SideB wins)
    let has_battle_end = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::BattleEnd {
                winner: SideId::SideB
            }
        )
    });
    assert!(
        has_battle_end,
        "TEETH: BattleEnd{{winner:SideB}} must be emitted after weather chip KO with no SideA backup; \
         an impl that emits Faint but not BattleEnd fails here"
    );

    assert_eq!(
        state.outcome,
        BattleOutcome::SideBWins,
        "TEETH: state.outcome must be SideBWins after weather chip KO; \
         an impl that emits BattleEnd but forgets to update state.outcome fails here"
    );

    assert_eq!(
        state.side_a.active_monster().current_hp,
        0,
        "TEETH: current_hp must be 0 after chip KO; \
         an impl that doesn't saturating_sub fails here"
    );
}

// ===========================================================================
// RT-W14-03: Weather chip floor at tiny HP (max_hp=1)
//
// A monster with max_hp=1 under Sandstorm: 1/16 = 0, but the floor of 1
// ensures exactly 1 chip damage (not 0).
//
// Kills: an impl that omits the .max(1) floor from weather_chip_amount,
// producing 0 chip for max_hp=1.
// ===========================================================================

/// Kills: an impl that drops the .max(1) floor from weather_chip_amount —
/// for max_hp=1, 1/16=0 without the floor, so chip=0 and HP is unchanged,
/// but the spec requires chip >= 1.
#[test]
fn weather_chip_floor_at_tiny_hp() {
    let mut tiny = make_monster(Affinity::Fire, 1, 50);
    tiny.max_hp = 1;
    tiny.current_hp = 1;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![tiny],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: Some(WeatherEffect::Sandstorm { turns_remaining: 3 }),
    };

    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    let chip_events: Vec<_> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::WeatherDamage {
                    side: SideId::SideA,
                    ..
                }
            )
        })
        .collect();
    assert_eq!(
        chip_events.len(),
        1,
        "TEETH: max_hp=1 Fire under Sandstorm must receive exactly 1 WeatherDamage event; \
         an impl without the .max(1) floor skips chip entirely (amount=0, no event)"
    );
    match &chip_events[0] {
        BattleEvent::WeatherDamage { amount, .. } => {
            assert_eq!(
                *amount, 1,
                "TEETH: weather chip for max_hp=1 must be 1 (floor of max(1, 1/16)=max(1,0)); \
                 an impl without the floor produces 0 — violating the minimum-1 rule"
            );
        }
        _ => panic!("expected WeatherDamage"),
    }
    // HP must have decreased (0 HP after chip of 1 from max_hp=1)
    assert_eq!(
        state.side_a.active_monster().current_hp,
        0,
        "TEETH: current_hp must be 0 after chip of 1 on max_hp=1 monster; \
         an impl without the floor leaves HP at 1 (no chip applied)"
    );
}

// ===========================================================================
// RT-W14-04: Earth monster does NOT take Sandstorm chip
//
// apply_weather_damage with Sandstorm and an Earth active monster:
// no WeatherDamage event, HP unchanged.
//
// Kills: an impl where sandstorm_immune returns false for Earth, or one where
// the immunity check is never consulted.
// ===========================================================================

/// Kills: an impl where sandstorm_immune(Earth) returns false (chip lands on Earth),
/// or one that never calls the immunity check.
#[test]
fn sandstorm_immune_earth() {
    let earth_monster = make_monster(Affinity::Earth, 160, 50);
    let water_opponent = make_monster(Affinity::Water, 100, 40);
    let mut state = make_battle_state(earth_monster, water_opponent);
    state.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });

    let pre_hp = state.side_a.active_monster().current_hp;
    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    let chip_to_earth: Vec<_> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::WeatherDamage {
                    side: SideId::SideA,
                    ..
                }
            )
        })
        .collect();
    assert!(
        chip_to_earth.is_empty(),
        "TEETH: Earth must be immune to Sandstorm chip (ADR-0095); \
         an impl where sandstorm_immune(Earth) is false chips Earth — \
         got WeatherDamage events: {chip_to_earth:?}"
    );
    assert_eq!(
        state.side_a.active_monster().current_hp,
        pre_hp,
        "TEETH: Earth monster HP must be unchanged under Sandstorm (immune); \
         a wrong immunity check would reduce HP"
    );
}

// ===========================================================================
// RT-W14-05: Water monster does NOT take Hail chip
//
// apply_weather_damage with Hail and a Water active monster:
// no WeatherDamage event, HP unchanged.
//
// Kills: an impl where hail_immune returns false for Water, or one that uses
// Earth immunity for Hail (correct for Sandstorm, wrong for Hail).
// ===========================================================================

/// Kills: an impl where hail_immune(Water) is false (Hail chips Water),
/// or one that uses Earth immunity for Hail (chips Water, skips Earth instead).
#[test]
fn hail_immune_water() {
    let water_monster = make_monster(Affinity::Water, 160, 50);
    let fire_opponent = make_monster(Affinity::Fire, 100, 40);
    let mut state = make_battle_state(water_monster, fire_opponent);
    state.weather = Some(WeatherEffect::Hail { turns_remaining: 3 });

    let pre_hp = state.side_a.active_monster().current_hp;
    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    let chip_to_water: Vec<_> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::WeatherDamage {
                    side: SideId::SideA,
                    ..
                }
            )
        })
        .collect();
    assert!(
        chip_to_water.is_empty(),
        "TEETH: Water must be immune to Hail chip (ADR-0095); \
         an impl where hail_immune(Water) returns false chips Water — \
         got WeatherDamage events: {chip_to_water:?}. \
         An impl using Earth immunity for Hail would also chip Water here."
    );
    assert_eq!(
        state.side_a.active_monster().current_hp,
        pre_hp,
        "TEETH: Water monster HP must be unchanged under Hail (immune); \
         a wrong immunity check reduces HP"
    );
}

// ===========================================================================
// RT-W14-06: Rain deals NO chip damage (attack modifier only)
//
// apply_weather_damage with Rain: no WeatherDamage events for either side
// (Rain has no end-of-turn chip; it only modifies attack power).
//
// Kills: an impl that confuses Rain with Sandstorm/Hail and applies chip
// to all non-immune monsters under Rain.
// ===========================================================================

/// Kills: an impl that applies chip damage under Rain — emitting WeatherDamage
/// for non-immune monsters even though Rain has no end-of-turn chip in ADR-0095.
#[test]
fn rain_has_no_chip() {
    // Fire and Plant: both non-immune to Sandstorm/Hail, but Rain has no chip.
    let fire_monster = make_monster(Affinity::Fire, 100, 50);
    let plant_opponent = make_monster(Affinity::Plant, 100, 40);
    let mut state = make_battle_state(fire_monster, plant_opponent);
    state.weather = Some(WeatherEffect::Rain { turns_remaining: 3 });

    let pre_hp_a = state.side_a.active_monster().current_hp;
    let pre_hp_b = state.side_b.active_monster().current_hp;

    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    let chip_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::WeatherDamage { .. }))
        .collect();
    assert!(
        chip_events.is_empty(),
        "TEETH: Rain has NO end-of-turn chip damage (only attack modifier); \
         an impl that applies chip under Rain emits WeatherDamage events — \
         got: {chip_events:?}"
    );
    assert_eq!(
        state.side_a.active_monster().current_hp,
        pre_hp_a,
        "TEETH: Fire monster HP must be unchanged under Rain (Rain has no chip)"
    );
    assert_eq!(
        state.side_b.active_monster().current_hp,
        pre_hp_b,
        "TEETH: Plant monster HP must be unchanged under Rain (Rain has no chip)"
    );
}

// ===========================================================================
// RT-W14-07: Sun deals NO chip damage (attack modifier only)
//
// apply_weather_damage with Sun: no WeatherDamage events for either side.
//
// Kills: an impl that applies chip under Sun, confusing it with Sandstorm/Hail.
// ===========================================================================

/// Kills: an impl that applies chip damage under Sun, emitting WeatherDamage
/// for non-immune monsters even though Sun has no end-of-turn chip.
#[test]
fn sun_has_no_chip() {
    // Water and Electric: both non-immune to Sandstorm/Hail.
    let water_monster = make_monster(Affinity::Water, 100, 50);
    let electric_opponent = make_monster(Affinity::Electric, 100, 40);
    let mut state = make_battle_state(water_monster, electric_opponent);
    state.weather = Some(WeatherEffect::Sun { turns_remaining: 3 });

    let pre_hp_a = state.side_a.active_monster().current_hp;
    let pre_hp_b = state.side_b.active_monster().current_hp;

    let mut events: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state, &mut events);

    let chip_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::WeatherDamage { .. }))
        .collect();
    assert!(
        chip_events.is_empty(),
        "TEETH: Sun has NO end-of-turn chip damage (only attack modifier); \
         an impl that applies chip under Sun emits WeatherDamage events — \
         got: {chip_events:?}"
    );
    assert_eq!(
        state.side_a.active_monster().current_hp,
        pre_hp_a,
        "TEETH: Water monster HP must be unchanged under Sun (Sun has no chip)"
    );
    assert_eq!(
        state.side_b.active_monster().current_hp,
        pre_hp_b,
        "TEETH: Electric monster HP must be unchanged under Sun (Sun has no chip)"
    );
}

// ===========================================================================
// RT-W14-08: Weather tick preserves weather until turns_remaining reaches 0
//
// Weather with turns=3: tick → 2, tick → 1, tick → expires (None + WeatherExpired).
// At turns=2 and turns=1 (before the final tick), no WeatherExpired is emitted.
//
// Kills:
//   - An impl that clears weather at turns=3 (off-by-two, clears too early).
//   - An impl that clears weather at turns=2 (off-by-one).
//   - An impl that never clears weather (WeatherExpired never emitted).
//   - An impl that emits WeatherExpired before the final tick.
// ===========================================================================

/// Kills: an impl with an off-by-one in the expiry check (clears at turns=1
/// before decrement, clears at turns=2, or clears at turns=3);
/// an impl that never clears weather (state.weather remains Some after turns→0);
/// an impl that emits WeatherExpired prematurely.
#[test]
fn weather_tick_preserves_weather_until_zero() {
    let monster_a = make_monster(Affinity::Fire, 100, 50);
    let monster_b = make_monster(Affinity::Water, 100, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    state.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });

    // Tick 1: 3 → 2, no expiry
    let mut events1: Vec<BattleEvent> = Vec::new();
    tick_weather(&mut state, &mut events1);

    assert!(
        matches!(
            &state.weather,
            Some(WeatherEffect::Sandstorm { turns_remaining: 2 })
        ),
        "TEETH: Sandstorm{{turns:3}} → tick → must be Sandstorm{{turns:2}}; \
         an impl clearing at turns=3 produces None, an off-by-two produces wrong count"
    );
    assert!(
        !events1
            .iter()
            .any(|e| matches!(e, BattleEvent::WeatherExpired)),
        "TEETH: NO WeatherExpired at tick 1 (turns 3→2); \
         a premature-expiry impl emits it here"
    );

    // Tick 2: 2 → 1, no expiry
    let mut events2: Vec<BattleEvent> = Vec::new();
    tick_weather(&mut state, &mut events2);

    assert!(
        matches!(
            &state.weather,
            Some(WeatherEffect::Sandstorm { turns_remaining: 1 })
        ),
        "TEETH: Sandstorm{{turns:2}} → tick → must be Sandstorm{{turns:1}}; \
         an off-by-one clearing at turns=2 produces None here"
    );
    assert!(
        !events2
            .iter()
            .any(|e| matches!(e, BattleEvent::WeatherExpired)),
        "TEETH: NO WeatherExpired at tick 2 (turns 2→1); \
         an impl clearing at turns=2 would emit WeatherExpired here (off-by-one)"
    );

    // Tick 3: 1 → 0 → clear, emit WeatherExpired
    let mut events3: Vec<BattleEvent> = Vec::new();
    tick_weather(&mut state, &mut events3);

    assert!(
        state.weather.is_none(),
        "TEETH: Sandstorm{{turns:1}} → tick → weather must be cleared (None); \
         an impl that decrements to 0 without clearing fails here; \
         an impl that never expires leaves Some(Sandstorm{{turns:0}}) here"
    );
    assert!(
        events3
            .iter()
            .any(|e| matches!(e, BattleEvent::WeatherExpired)),
        "TEETH: WeatherExpired must be emitted when weather expires (turns 1→0→clear); \
         an impl that clears state.weather but forgets the event fails here"
    );
}

// ===========================================================================
// RT-W14-09: Rain attack modifier is applied after variance step
//
// Known-answer: Fire attacker (L5, atk=40) using Water skill (power=40, variance=100)
// vs Plant defender (def=40) under Rain.
//
// Formula:
//   base = (2*5/5 + 2) * 40 * 40 / 40 / 50 + 2
//        = (2+2) * 40 * 40 / 40 / 50 + 2
//        = 4 * 40 * 40 / 40 / 50 + 2 = 160*40/40/50+2 = 160/50+2 = 3+2 = 5
//   STAB: Water skill on Fire attacker — no STAB. stab = 5.
//   type_mod: Water vs Plant = 5 (not very effective in type_chart.ron).
//             5 * 5 / 10 = 2 (integer division)
//   variance_mod: 2 * 100 / 100 = 2
//   weather_mod (Rain + Water): 2 * 3 / 2 = 3 (integer: 6/2 = 3)
//   final = max(1, 3) = 3
//
// vs no weather:
//   weather_mod (None): 2 * 1 / 1 = 2
//   final = max(1, 2) = 2
//
// Rain must boost Water damage: 3 > 2.
//
// Kills: an impl where weather_attack_modifier is consulted but returns (1,1)
// for Rain+Water, or where the modifier is applied before instead of after variance.
// ===========================================================================

/// Kills: an impl where weather_attack_modifier returns (1,1) for Rain+Water
/// (produces 5 instead of 7, failing the > check);
/// or an impl that applies the weather modifier before variance
/// (would produce different but still incorrect amounts).
#[test]
fn rain_boosts_water_damage_known_answer() {
    use crate::combat::damage::calc_damage;

    let chart = make_type_chart();

    // Fire attacker, Water skill, vs Plant defender.
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 100,
        max_hp: 100,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![2],
        status: None,
    };
    let defender = BattleMonster {
        species_id: 2,
        affinity: Affinity::Plant,
        level: 5,
        current_hp: 100,
        max_hp: 100,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 40,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![],
        status: None,
    };
    let water_skill = SkillDef {
        id: 2,
        name: "Water Gun".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    };

    let rain = WeatherEffect::Rain { turns_remaining: 3 };

    let (dmg_no_weather, _) = calc_damage(&attacker, &defender, &water_skill, &chart, 100, None);
    let (dmg_rain, _) = calc_damage(&attacker, &defender, &water_skill, &chart, 100, Some(&rain));

    // Known answers from the formula above:
    assert_eq!(
        dmg_no_weather, 2,
        "TEETH: Water skill with no weather on Fire attacker vs Plant must deal 2 \
         (Water vs Plant = NVE, type_mod=5*5/10=2); \
         a wrong formula produces a different value and masks the weather comparison"
    );
    assert_eq!(
        dmg_rain, 3,
        "TEETH: Water skill under Rain on Fire attacker vs Plant must deal 3 \
         (2 * 3/2 = 3 via integer arithmetic); \
         an impl returning (1,1) for Rain+Water produces 2 instead of 3"
    );
    assert!(
        dmg_rain > dmg_no_weather,
        "TEETH: Rain must boost Water damage ({dmg_rain}) above no-weather ({dmg_no_weather}); \
         an impl where weather_attack_modifier returns (1,1) for Rain+Water fails here"
    );
}

// ===========================================================================
// RT-W14-10: Sun nerfs Water damage known-answer
//
// Same formula as RT-W14-09 but with Sun + Water skill.
// variance_mod = 2 (Water vs Plant = NVE); Sun + Water → (1,2): 2*1/2=1; max(1,1)=1.
// No weather: 2. Sun halves Water: 1 < 2.
//
// Kills: an impl where weather_attack_modifier returns (1,1) for Sun+Water
// (produces 2 instead of 1, failing the < check).
// ===========================================================================

/// Kills: an impl that returns (1,1) for Sun+Water (no nerf, dmg stays 2 instead of 1),
/// or one that applies Rain's logic to Sun (would boost Water under Sun).
#[test]
fn sun_nerfs_water_damage_known_answer() {
    use crate::combat::damage::calc_damage;

    let chart = make_type_chart();

    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 100,
        max_hp: 100,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![2],
        status: None,
    };
    let defender = BattleMonster {
        species_id: 2,
        affinity: Affinity::Plant,
        level: 5,
        current_hp: 100,
        max_hp: 100,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 40,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![],
        status: None,
    };
    let water_skill = SkillDef {
        id: 2,
        name: "Water Gun".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    };

    let sun = WeatherEffect::Sun { turns_remaining: 3 };

    let (dmg_no_weather, _) = calc_damage(&attacker, &defender, &water_skill, &chart, 100, None);
    let (dmg_sun, _) = calc_damage(&attacker, &defender, &water_skill, &chart, 100, Some(&sun));

    assert_eq!(
        dmg_no_weather, 2,
        "baseline Water damage with no weather must be 2 \
         (Water vs Plant = NVE, type_mod=5*5/10=2; formula anchor)"
    );
    assert_eq!(
        dmg_sun, 1,
        "TEETH: Water skill under Sun must deal 1 (2*1/2=1 via integer arithmetic); \
         an impl returning (1,1) for Sun+Water produces 2 (no nerf); \
         an impl applying Rain's Water boost to Sun produces 3 (wrong boost)"
    );
    assert!(
        dmg_sun < dmg_no_weather,
        "TEETH: Sun must NERF Water damage ({dmg_sun}) below no-weather ({dmg_no_weather}); \
         an impl without the Sun+Water nerf fails here"
    );
}
