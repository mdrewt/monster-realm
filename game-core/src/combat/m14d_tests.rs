//! M14d gating tests — acceptance criteria for the M14d weather/field-state slice.
//!
//! ALL tests start RED (compile error) because the following do not exist yet:
//!   - `game-core/src/combat/weather.rs` (module, all types, all functions)
//!   - `WeatherEffect { Rain | Sun | Sandstorm | Hail }` enum
//!   - `WeatherKind { Rain | Sun | Sandstorm | Hail }` enum
//!   - `WEATHER_DEFAULT_TURNS: u8`
//!   - `weather_attack_modifier`, `sandstorm_immune`, `hail_immune` fns
//!   - `apply_weather_damage`, `tick_weather` fns
//!   - `BattleState.weather: Option<WeatherEffect>` field
//!   - `BattleEvent::WeatherSet`, `WeatherDamage`, `WeatherExpired` variants
//!   - `SkillDef.sets_weather: Option<WeatherKind>` field
//!   - `calc_damage` weather parameter
//!
//! Criterion → test mapping:
//!   EARS-1  (Rain boosts Water)       → weather_modifier_rain_boosts_water
//!   EARS-2  (Rain nerfs Fire)         → weather_modifier_rain_nerfs_fire
//!   EARS-3  (Sun boosts Fire)         → weather_modifier_sun_boosts_fire
//!   EARS-4  (Sun nerfs Water)         → weather_modifier_sun_nerfs_water
//!   EARS-5  (neutral unchanged)       → weather_modifier_neutral_is_unchanged
//!   EARS-6  (sandstorm chips)         → sandstorm_chips_non_earth
//!   EARS-7  (hail chips)              → hail_chips_non_water
//!   EARS-8  (chip floor 1)            → chip_amount_floor_1
//!   EARS-9  (weather ticks down)      → weather_ticks_down
//!   EARS-10 (weather expires)         → weather_expires
//!   EARS-11 (skill sets weather)      → skill_sets_weather
//!   EARS-12 (no self-boost)           → weather_does_not_boost_own_hit

use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::combat::weather::{
    apply_weather_damage, hail_immune, sandstorm_immune, tick_weather, weather_attack_modifier,
    WeatherEffect, WeatherKind, WEATHER_DEFAULT_TURNS,
};
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

/// All rolls guarantee hits, no speed tie ambiguity.
fn always_hit_variance(a_faster: bool) -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: a_faster,
    }
}

/// StatusVariance with no blocking and no thaw — passes through unchanged.
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

/// Empty BattleStatusStore for 1-vs-1.
fn empty_status() -> BattleStatusStore {
    BattleStatusStore::new(1, 1)
}

fn water_skill() -> SkillDef {
    SkillDef {
        id: 2,
        name: "Water Gun".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    }
}

fn rain_dance_skill() -> SkillDef {
    SkillDef {
        id: 7,
        name: "Rain Dance".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 10,
        sets_weather: Some(WeatherKind::Rain),
        applies_status: None,
    }
}

// ---------------------------------------------------------------------------
// TEST 1 (EARS-1): Rain boosts Water attacks (3/2 multiplier)
//
// weather_attack_modifier(Some(Rain), Water) → (3, 2).
// With the same base damage, Rain must produce higher damage than no-weather.
//
// Kills: an impl that returns (1,1) for Rain+Water instead of (3,2),
// or swaps Rain boosts (applies to Fire instead of Water).
// ---------------------------------------------------------------------------

/// Kills: an impl returning (1,1) for Rain+Water — produces the same damage as
/// no-weather, failing the > assertion; or an impl swapping Rain to boost Fire.
#[test]
fn weather_modifier_rain_boosts_water() {
    let rain = WeatherEffect::Rain { turns_remaining: 3 };
    let (numer, denom) = weather_attack_modifier(Some(&rain), Affinity::Water);
    assert_eq!(
        (numer, denom),
        (3, 2),
        "TEETH: Rain + Water must return (3,2) — a (1,1) impl produces the same damage \
         as no-weather and fails the known-answer check; a swapped impl gives (1,2)"
    );
}

// ---------------------------------------------------------------------------
// TEST 2 (EARS-2): Rain nerfs Fire attacks (1/2 multiplier)
//
// weather_attack_modifier(Some(Rain), Fire) → (1, 2).
// Rain halves Fire damage.
//
// Kills: an impl that doesn't nerf Fire under Rain (returns (1,1) or (3,2)).
// ---------------------------------------------------------------------------

/// Kills: an impl returning (1,1) for Rain+Fire (no nerf) or (3,2) (wrong boost).
#[test]
fn weather_modifier_rain_nerfs_fire() {
    let rain = WeatherEffect::Rain { turns_remaining: 3 };
    let (numer, denom) = weather_attack_modifier(Some(&rain), Affinity::Fire);
    assert_eq!(
        (numer, denom),
        (1, 2),
        "TEETH: Rain + Fire must return (1,2) — an impl returning (1,1) doesn't nerf \
         Fire under Rain; a wrong impl returning (3,2) would boost Fire under Rain"
    );
}

// ---------------------------------------------------------------------------
// TEST 3 (EARS-3): Sun boosts Fire attacks (3/2 multiplier)
//
// weather_attack_modifier(Some(Sun), Fire) → (3, 2).
//
// Kills: an impl that applies Rain's modifier to Sun, or returns (1,1) for Sun+Fire.
// ---------------------------------------------------------------------------

/// Kills: an impl that applies Rain's logic to Sun (giving (1,2) for Fire under Sun)
/// or an impl returning (1,1) for Sun+Fire.
#[test]
fn weather_modifier_sun_boosts_fire() {
    let sun = WeatherEffect::Sun { turns_remaining: 3 };
    let (numer, denom) = weather_attack_modifier(Some(&sun), Affinity::Fire);
    assert_eq!(
        (numer, denom),
        (3, 2),
        "TEETH: Sun + Fire must return (3,2) — an impl that swaps Sun/Rain modifiers \
         returns (1,2) for Fire under Sun; a (1,1) impl fails the known-answer check"
    );
}

// ---------------------------------------------------------------------------
// TEST 4 (EARS-4): Sun nerfs Water attacks (1/2 multiplier)
//
// weather_attack_modifier(Some(Sun), Water) → (1, 2).
//
// Kills: an impl that applies Rain's Water boost to Sun+Water, or returns (1,1).
// ---------------------------------------------------------------------------

/// Kills: an impl that swaps Sun/Rain modifiers (gives (3,2) for Water under Sun),
/// or returns (1,1) for Sun+Water.
#[test]
fn weather_modifier_sun_nerfs_water() {
    let sun = WeatherEffect::Sun { turns_remaining: 3 };
    let (numer, denom) = weather_attack_modifier(Some(&sun), Affinity::Water);
    assert_eq!(
        (numer, denom),
        (1, 2),
        "TEETH: Sun + Water must return (1,2) — a swapped impl gives (3,2) for Water \
         under Sun; a (1,1) impl fails the known-answer check"
    );
}

// ---------------------------------------------------------------------------
// TEST 5 (EARS-5): Sandstorm and Hail have no attack modifier for any affinity
//
// weather_attack_modifier(Some(Sandstorm), Plant) → (1, 1).
// weather_attack_modifier(Some(Hail), Plant) → (1, 1).
// weather_attack_modifier(None, Plant) → (1, 1).
//
// Kills: an impl that accidentally applies Rain/Sun's logic to Sandstorm/Hail.
// ---------------------------------------------------------------------------

/// Kills: an impl that applies Rain's Water boost to Sandstorm/Hail (e.g., if
/// the match fallthrough accidentally picks up Rain's arm for a non-Rain weather).
#[test]
fn weather_modifier_neutral_is_unchanged() {
    // Sandstorm + Plant (not Water or Fire) → no modifier
    let sandstorm = WeatherEffect::Sandstorm { turns_remaining: 3 };
    let (n, d) = weather_attack_modifier(Some(&sandstorm), Affinity::Plant);
    assert_eq!(
        (n, d),
        (1, 1),
        "TEETH: Sandstorm + Plant must return (1,1); \
         an impl that accidentally applies Rain's arm returns (3,2) or (1,2)"
    );

    // Hail + Plant → no modifier
    let hail = WeatherEffect::Hail { turns_remaining: 3 };
    let (n2, d2) = weather_attack_modifier(Some(&hail), Affinity::Plant);
    assert_eq!(
        (n2, d2),
        (1, 1),
        "TEETH: Hail + Plant must return (1,1); \
         an impl incorrectly applying Sun's arm would return (1,2)"
    );

    // No weather → no modifier
    let (n3, d3) = weather_attack_modifier(None, Affinity::Water);
    assert_eq!(
        (n3, d3),
        (1, 1),
        "TEETH: None weather + Water must return (1,1); \
         an impl accidentally applying Rain's Water boost to None fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 6 (EARS-6): Sandstorm deals chip to non-Earth, skips Earth
//
// apply_weather_damage with Sandstorm:
//   - Water monster (non-immune): takes chip, emits WeatherDamage
//   - Earth monster (immune): skipped, no WeatherDamage
//
// Kills: an impl that skips chip for all monsters (no chip-damage loop),
// or one that chips Earth (wrong immunity check).
// ---------------------------------------------------------------------------

/// Kills: an impl that skips Sandstorm chip for all monsters (events empty);
/// an impl that doesn't skip Earth (emits WeatherDamage for Earth);
/// an impl that mistakes Water immunity for Earth (wrong branch).
#[test]
fn sandstorm_chips_non_earth() {
    // Part A: Water monster under Sandstorm — must receive chip
    let water_monster = make_monster(Affinity::Water, 160, 50);
    let neutral_opponent = make_monster(Affinity::Fire, 100, 40);
    let mut state_a = make_battle_state(water_monster, neutral_opponent);
    state_a.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });

    let mut events_a: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state_a, &mut events_a);

    let chip_to_a: Vec<_> = events_a
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
        chip_to_a.len(),
        1,
        "TEETH: Water monster (non-Earth, non-immune to Sandstorm) must receive \
         exactly 1 WeatherDamage event; an impl skipping chip emits 0 events here"
    );

    // Verify chip amount = max_hp/16 = 160/16 = 10
    match &chip_to_a[0] {
        BattleEvent::WeatherDamage { side, amount } => {
            assert_eq!(*side, SideId::SideA, "WeatherDamage must target SideA");
            assert_eq!(
                *amount, 10,
                "TEETH: Sandstorm chip for max_hp=160 must be 10 (160/16); \
                 a /8 impl produces 20, a /32 impl produces 5"
            );
        }
        _ => panic!("expected WeatherDamage"),
    }
    assert_eq!(
        state_a.side_a.active_monster().current_hp,
        150,
        "TEETH: Water monster HP must decrease from 160 to 150 after Sandstorm chip"
    );

    // Part B: Earth monster under Sandstorm — must be immune (no chip)
    let earth_monster = make_monster(Affinity::Earth, 160, 50);
    let fire_opponent = make_monster(Affinity::Fire, 100, 40);
    let mut state_b = make_battle_state(earth_monster, fire_opponent);
    state_b.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });

    let mut events_b: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state_b, &mut events_b);

    let chip_to_earth: Vec<_> = events_b
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
        "TEETH: Earth monster must be immune to Sandstorm chip (no WeatherDamage); \
         an impl with wrong immunity check emits WeatherDamage for Earth here — \
         got {chip_to_earth:?}"
    );
    assert_eq!(
        state_b.side_a.active_monster().current_hp,
        160,
        "TEETH: Earth monster HP must be unchanged (immune to Sandstorm); \
         a wrong immunity check would reduce HP here"
    );
}

// ---------------------------------------------------------------------------
// TEST 7 (EARS-7): Hail deals chip to non-Water, skips Water
//
// apply_weather_damage with Hail:
//   - Fire monster (non-immune): takes chip, emits WeatherDamage
//   - Water monster (immune): skipped, no WeatherDamage
//
// Kills: an impl that confuses Hail immunity (immune Water) with Sandstorm
// immunity (immune Earth), or one that skips chip for all.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses Earth immunity for Hail (chips Earth, skips non-Earth),
/// or an impl that skips chip for all monsters under Hail.
#[test]
fn hail_chips_non_water() {
    // Part A: Fire monster under Hail — must receive chip
    let fire_monster = make_monster(Affinity::Fire, 160, 50);
    let plant_opponent = make_monster(Affinity::Plant, 100, 40);
    let mut state_a = make_battle_state(fire_monster, plant_opponent);
    state_a.weather = Some(WeatherEffect::Hail { turns_remaining: 3 });

    let mut events_a: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state_a, &mut events_a);

    let chip_events: Vec<_> = events_a
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
        "TEETH: Fire monster (non-Water, non-immune to Hail) must receive exactly 1 \
         WeatherDamage event; an impl skipping Hail chip emits 0 events here"
    );
    match &chip_events[0] {
        BattleEvent::WeatherDamage { side, amount } => {
            assert_eq!(*side, SideId::SideA, "WeatherDamage must target SideA");
            assert_eq!(
                *amount, 10,
                "TEETH: Hail chip for max_hp=160 must be 10 (160/16); \
                 an impl using /8 produces 20"
            );
        }
        _ => panic!("expected WeatherDamage"),
    }

    // Part B: Water monster under Hail — must be immune (no chip)
    let water_monster = make_monster(Affinity::Water, 160, 50);
    let fire_opponent2 = make_monster(Affinity::Fire, 100, 40);
    let mut state_b = make_battle_state(water_monster, fire_opponent2);
    state_b.weather = Some(WeatherEffect::Hail { turns_remaining: 3 });

    let mut events_b: Vec<BattleEvent> = Vec::new();
    apply_weather_damage(&mut state_b, &mut events_b);

    let chip_to_water: Vec<_> = events_b
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
        "TEETH: Water monster must be immune to Hail chip (no WeatherDamage); \
         an impl using Earth immunity logic for Hail would chip Water and fail here — \
         got {chip_to_water:?}"
    );
    assert_eq!(
        state_b.side_a.active_monster().current_hp,
        160,
        "TEETH: Water monster HP must be unchanged (immune to Hail); \
         a wrong immunity check would reduce HP here"
    );
}

// ---------------------------------------------------------------------------
// TEST 8 (EARS-8): Weather chip amount has a floor of 1
//
// apply_weather_damage on a monster with max_hp < 16: max_hp/16 = 0, but
// the floor of 1 ensures at least 1 chip is dealt.
//
// Kills: an impl that computes max_hp/16 without the .max(1) floor,
// producing 0 chip damage and no HP change.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses max_hp/16 without a floor of 1 — for max_hp=15
/// (15/16=0) the chip would be 0 and HP would be unchanged, but the floor of 1
/// means HP must decrease by exactly 1.
#[test]
fn chip_amount_floor_1() {
    // max_hp=15: 15/16 = 0 via integer division → floor of 1 must apply
    let tiny_monster = {
        let mut m = make_monster(Affinity::Fire, 15, 50);
        m.max_hp = 15;
        m.current_hp = 15;
        m
    };
    let opponent = make_monster(Affinity::Plant, 100, 40);
    let mut state = make_battle_state(tiny_monster, opponent);
    state.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });

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
        "TEETH: tiny Fire monster under Sandstorm must receive exactly 1 WeatherDamage; \
         an impl skipping chip for 0-amount (no floor) emits 0 events here"
    );
    match &chip_events[0] {
        BattleEvent::WeatherDamage { side, amount } => {
            assert_eq!(*side, SideId::SideA, "WeatherDamage must target SideA");
            assert_eq!(
                *amount, 1,
                "TEETH: Sandstorm chip for max_hp=15 must be 1 (floor of max(1, 15/16)); \
                 an impl without the .max(1) floor produces 0 damage and emits \
                 WeatherDamage{{amount:0}} or skips emission entirely"
            );
        }
        _ => panic!("expected WeatherDamage"),
    }
    assert_eq!(
        state.side_a.active_monster().current_hp,
        14,
        "TEETH: HP must decrease from 15 to 14 (exactly 1 chip from the floor); \
         an impl without the floor leaves HP at 15"
    );
}

// ---------------------------------------------------------------------------
// TEST 9 (EARS-9): tick_weather decrements turns_remaining by 1
//
// BattleState.weather = Rain{turns_remaining: 3}. tick_weather → Rain{turns_remaining: 2}.
// No WeatherExpired event emitted.
//
// Kills: an impl that decrements by 2, doesn't decrement, or clears weather early.
// ---------------------------------------------------------------------------

/// Kills: an impl that decrements by 2 (produces 1), doesn't decrement (stays 3),
/// or clears weather when turns_remaining > 1.
#[test]
fn weather_ticks_down() {
    let monster_a = make_monster(Affinity::Fire, 100, 50);
    let monster_b = make_monster(Affinity::Water, 100, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    state.weather = Some(WeatherEffect::Rain { turns_remaining: 3 });

    let mut events: Vec<BattleEvent> = Vec::new();
    tick_weather(&mut state, &mut events);

    // Weather must still be Rain with turns_remaining = 2
    match &state.weather {
        Some(WeatherEffect::Rain { turns_remaining }) => {
            assert_eq!(
                *turns_remaining, 2,
                "TEETH: Rain{turns_remaining:3} must tick to turns_remaining=2; \
                 a -=2 impl produces 1, a no-op impl leaves it at 3"
            );
        }
        Some(other) => panic!("expected Rain, got {other:?}"),
        None => panic!(
            "TEETH: weather must not be cleared when turns_remaining is still > 1 after tick"
        ),
    }

    // No WeatherExpired when turns > 1 after decrement
    let expired = events
        .iter()
        .any(|e| matches!(e, BattleEvent::WeatherExpired));
    assert!(
        !expired,
        "TEETH: WeatherExpired must NOT be emitted when turns_remaining decrements from 3 to 2; \
         a premature-expiry impl emits WeatherExpired here"
    );
}

// ---------------------------------------------------------------------------
// TEST 10 (EARS-10): tick_weather expires weather when turns_remaining reaches 0
//
// BattleState.weather = Sun{turns_remaining: 1}. tick_weather → weather = None,
// WeatherExpired event emitted.
//
// Kills: an impl that emits WeatherExpired but doesn't clear weather,
// or one that never clears weather, or clears at turns_remaining=2.
// ---------------------------------------------------------------------------

/// Kills: an impl that emits WeatherExpired but forgets to set weather=None;
/// an impl that never clears weather; an impl that uses the wrong threshold (clears at 2).
#[test]
fn weather_expires() {
    let monster_a = make_monster(Affinity::Fire, 100, 50);
    let monster_b = make_monster(Affinity::Water, 100, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    state.weather = Some(WeatherEffect::Sun { turns_remaining: 1 });

    let mut events: Vec<BattleEvent> = Vec::new();
    tick_weather(&mut state, &mut events);

    // Weather must be cleared
    assert!(
        state.weather.is_none(),
        "TEETH: Sun{{turns_remaining:1}} → tick → weather must become None; \
         an impl that decrements to 0 without clearing fails here"
    );

    // WeatherExpired event must have been emitted
    let expired = events
        .iter()
        .any(|e| matches!(e, BattleEvent::WeatherExpired));
    assert!(
        expired,
        "TEETH: WeatherExpired must be emitted when Sun runs out (turns 1→0→clear); \
         an impl that clears weather without emitting the event fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 11 (EARS-11): A weather-setting skill sets state.weather + emits WeatherSet
//
// resolve_full_turn with a skill that has sets_weather=Some(Rain):
//   - state.weather becomes Some(Rain{WEATHER_DEFAULT_TURNS}) AFTER the turn
//   - events contain WeatherSet { weather: Rain{WEATHER_DEFAULT_TURNS} }
//
// Kills: an impl that sets weather BEFORE calculating damage (self-boost bug),
// an impl that never sets weather from skill, or one that emits WeatherSet
// with the wrong turns_remaining.
// ---------------------------------------------------------------------------

/// Kills: an impl that never sets weather from a skill (state.weather stays None);
/// an impl that emits WeatherSet with the wrong turns_remaining;
/// an impl that omits the WeatherSet event entirely.
#[test]
fn skill_sets_weather() {
    let chart = make_type_chart();
    let variance = always_hit_variance(true);
    let sv = no_block_status_variance();

    // Side A uses a Water skill with sets_weather=Some(Rain)
    let monster_a = make_monster(Affinity::Water, 200, 80); // faster
    let monster_b = make_monster(Affinity::Plant, 200, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = empty_status();

    let skills = vec![rain_dance_skill()];

    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 7 },
        TurnChoice::Attack { skill_id: 7 },
        &skills,
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // state.weather must be set to Rain
    assert!(
        matches!(&state.weather, Some(WeatherEffect::Rain { .. })),
        "TEETH: using a sets_weather=Rain skill must set state.weather to Some(Rain{{..}}); \
         an impl that never reads sets_weather leaves state.weather=None"
    );

    // turns_remaining must equal WEATHER_DEFAULT_TURNS
    if let Some(WeatherEffect::Rain { turns_remaining }) = &state.weather {
        assert_eq!(
            *turns_remaining,
            // After resolve_full_turn, tick_weather ran once — so it should be WEATHER_DEFAULT_TURNS - 1
            // unless the battle ended before tick. With two Water attackers vs Plant:
            // A (faster, Water Rain Dance, STAB, SE vs Plant) will likely KO B.
            // If battle ended, tick_weather is skipped. Let's check what actually happens.
            // The spec says tick_weather runs in phase 5 only if state.outcome == Ongoing.
            // With a 200-HP plant defender and level-5 Water attacker (attack=40, power=40),
            // the damage won't KO. So tick_weather WILL run, decrementing from 5 to 4.
            // But wait: both sides use skill_id=7 (Rain Dance). A goes first, sets Rain.
            // B also uses Rain Dance — resets weather to Rain{5}. Then tick_weather → Rain{4}.
            // So turns_remaining = WEATHER_DEFAULT_TURNS - 1 = 4.
            WEATHER_DEFAULT_TURNS - 1,
            "TEETH: after one full turn (sets_weather fires at WEATHER_DEFAULT_TURNS, \
             then tick_weather decrements once), turns_remaining must be \
             WEATHER_DEFAULT_TURNS-1 = {}; a wrong default produces a different value",
            WEATHER_DEFAULT_TURNS - 1
        );
    }

    // WeatherSet event must appear in events
    let weather_set_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::WeatherSet { .. }))
        .collect();
    assert!(
        !weather_set_events.is_empty(),
        "TEETH: a sets_weather skill must emit WeatherSet event; \
         an impl that sets state.weather but forgets the event fails here"
    );
    // The WeatherSet event must carry Rain
    match &weather_set_events[0] {
        BattleEvent::WeatherSet { weather } => {
            assert!(
                matches!(weather, WeatherEffect::Rain { turns_remaining } if *turns_remaining == WEATHER_DEFAULT_TURNS),
                "TEETH: WeatherSet must carry Rain{{turns_remaining: WEATHER_DEFAULT_TURNS={}}}; \
                 an impl using a wrong default or wrong variant fails here",
                WEATHER_DEFAULT_TURNS
            );
        }
        _ => panic!("expected WeatherSet event"),
    }
}

// ---------------------------------------------------------------------------
// TEST 12 (EARS-12): A Rain-setting Water skill does NOT get the Rain bonus on
// its own hit (weather is set AFTER damage)
//
// ADR-0095 D4: `sets_weather` fires AFTER the attack's damage is resolved.
// So a Water skill that sets Rain should calculate damage WITHOUT Rain's 3/2
// bonus on the same hit.
//
// Fixture:
//   - Pre-existing weather: None
//   - Side A: Water monster uses Rain Dance (Water, power=40, sets_weather=Rain)
//   - Compare damage vs. a plain Water skill with Rain already active
//   - The Rain Dance hit (which sets Rain) must NOT be boosted by Rain
//
// Kills: an impl that sets weather BEFORE resolving damage — the Rain Dance hit
// would be boosted (3/2), producing higher damage than a plain Water hit without Rain.
// ---------------------------------------------------------------------------

/// Kills: an impl that applies weather BEFORE damage resolution on the same turn —
/// if sets_weather runs before calc_damage, the Rain Dance hit gets the Rain bonus
/// (3/2), producing higher damage than the no-weather baseline (same Water skill
/// with weather=None). This assertion catches it by comparing the damage amount.
#[test]
fn weather_does_not_boost_own_hit() {
    let chart = make_type_chart();
    let sv = no_block_status_variance();

    // Fixture A: Weather=None, use Rain Dance (Water, power=40, sets_weather=Rain)
    //            This must NOT get the Rain bonus (weather is set AFTER damage).
    let skills_with_rain_dance = vec![rain_dance_skill()];

    let monster_a_no_rain = make_monster(Affinity::Water, 200, 80);
    let monster_b_no_rain = make_monster(Affinity::Plant, 200, 40);
    let mut state_no_rain = make_battle_state(monster_a_no_rain, monster_b_no_rain);
    state_no_rain.weather = None; // no pre-existing weather
    let mut status_no_rain = empty_status();

    let variance_a_first = TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 100, // B misses — only A's damage matters
        speed_tie_breaker: true,
    };

    let events_no_rain = resolve_full_turn(
        &mut state_no_rain,
        TurnChoice::Attack { skill_id: 7 }, // Rain Dance
        TurnChoice::Attack { skill_id: 7 }, // B also attacks but will miss
        &skills_with_rain_dance,
        &chart,
        &variance_a_first,
        &mut status_no_rain,
        &sv,
    );

    // Fixture B: Weather=Rain pre-existing, use plain Water skill (same power=40)
    //            This SHOULD get the Rain bonus (3/2).
    let plain_water_skill = water_skill();
    let skills_plain = vec![plain_water_skill];

    let monster_a_with_rain = make_monster(Affinity::Water, 200, 80);
    let monster_b_with_rain = make_monster(Affinity::Plant, 200, 40);
    let mut state_with_rain = make_battle_state(monster_a_with_rain, monster_b_with_rain);
    state_with_rain.weather = Some(WeatherEffect::Rain { turns_remaining: 5 }); // Rain already active
    let mut status_with_rain = empty_status();

    let events_with_rain = resolve_full_turn(
        &mut state_with_rain,
        TurnChoice::Attack { skill_id: 2 }, // plain Water skill
        TurnChoice::Attack { skill_id: 2 }, // B misses
        &skills_plain,
        &chart,
        &variance_a_first,
        &mut status_with_rain,
        &sv,
    );

    // Extract SideB damage from both scenarios (A attacked B in both)
    let damage_no_rain = events_no_rain.iter().find_map(|e| match e {
        BattleEvent::Damage {
            side: SideId::SideB,
            amount,
            ..
        } => Some(*amount),
        _ => None,
    });
    let damage_with_rain = events_with_rain.iter().find_map(|e| match e {
        BattleEvent::Damage {
            side: SideId::SideB,
            amount,
            ..
        } => Some(*amount),
        _ => None,
    });

    let dmg_no_rain =
        damage_no_rain.expect("Rain Dance skill must hit SideB and emit Damage event");
    let dmg_with_rain = damage_with_rain
        .expect("plain Water skill under Rain must hit SideB and emit Damage event");

    assert!(
        dmg_no_rain < dmg_with_rain,
        "TEETH (ADR-0095 D4): Rain Dance hit without pre-existing Rain ({dmg_no_rain}) \
         must deal LESS damage than a plain Water hit under pre-existing Rain ({dmg_with_rain}). \
         An impl that applies weather BEFORE its own damage would boost the Rain Dance hit \
         to the same level as the pre-existing Rain hit — violating the 'sets_weather fires \
         after damage' rule. Expected: {dmg_no_rain} < {dmg_with_rain}."
    );
}

// ---------------------------------------------------------------------------
// TEST: WeatherEffect::from_kind constructs with correct variant and turns
//
// Exhaustive compile gate: one call per WeatherKind variant + no wildcard match.
// Adding a new WeatherKind without updating this match → compile error.
//
// Kills: an impl that adds a WeatherKind variant without updating WeatherEffect::from_kind.
// ---------------------------------------------------------------------------

/// Kills: a from_kind impl that returns the wrong variant for a given kind
/// (e.g. always returning Rain), or an impl that ignores the turns parameter.
#[test]
fn weather_effect_from_kind_constructs_correctly() {
    let kinds = [
        WeatherKind::Rain,
        WeatherKind::Sun,
        WeatherKind::Sandstorm,
        WeatherKind::Hail,
    ];

    for kind in kinds {
        // Exhaustive match — NO wildcard arm. New WeatherKind variant → compile error.
        let effect = WeatherEffect::from_kind(kind, 3);
        let turns = match &effect {
            WeatherEffect::Rain { turns_remaining } => {
                assert_eq!(
                    kind,
                    WeatherKind::Rain,
                    "TEETH: from_kind(Rain, 3) must produce Rain variant"
                );
                *turns_remaining
            }
            WeatherEffect::Sun { turns_remaining } => {
                assert_eq!(
                    kind,
                    WeatherKind::Sun,
                    "TEETH: from_kind(Sun, 3) must produce Sun variant"
                );
                *turns_remaining
            }
            WeatherEffect::Sandstorm { turns_remaining } => {
                assert_eq!(
                    kind,
                    WeatherKind::Sandstorm,
                    "TEETH: from_kind(Sandstorm, 3) must produce Sandstorm variant"
                );
                *turns_remaining
            }
            WeatherEffect::Hail { turns_remaining } => {
                assert_eq!(
                    kind,
                    WeatherKind::Hail,
                    "TEETH: from_kind(Hail, 3) must produce Hail variant"
                );
                *turns_remaining
            }
        };
        assert_eq!(
            turns, 3,
            "TEETH: from_kind must use the provided turns parameter; \
             an impl that hardcodes WEATHER_DEFAULT_TURNS produces {WEATHER_DEFAULT_TURNS}, not 3"
        );
    }
}

// ---------------------------------------------------------------------------
// TEST: sandstorm_immune / hail_immune known-answer gate
//
// Kills: an impl that confuses Sandstorm immunity (Earth) with Hail immunity (Water).
// ---------------------------------------------------------------------------

/// Kills: an impl that swaps Sandstorm and Hail immunity (Earth immune to Hail,
/// Water immune to Sandstorm) — the known-answer assertions catch the swap.
#[test]
fn immunity_functions_return_correct_results() {
    // sandstorm_immune: only Earth is immune
    assert!(
        sandstorm_immune(Affinity::Earth),
        "TEETH: Earth must be immune to Sandstorm"
    );
    assert!(
        !sandstorm_immune(Affinity::Water),
        "TEETH: Water must NOT be immune to Sandstorm (Water is immune to Hail); \
         a swapped impl returns true for Water here"
    );
    assert!(
        !sandstorm_immune(Affinity::Fire),
        "Fire must not be immune to Sandstorm"
    );
    assert!(
        !sandstorm_immune(Affinity::Plant),
        "Plant must not be immune to Sandstorm"
    );

    // hail_immune: only Water is immune
    assert!(
        hail_immune(Affinity::Water),
        "TEETH: Water must be immune to Hail"
    );
    assert!(
        !hail_immune(Affinity::Earth),
        "TEETH: Earth must NOT be immune to Hail (Earth is immune to Sandstorm); \
         a swapped impl returns true for Earth here"
    );
    assert!(
        !hail_immune(Affinity::Fire),
        "Fire must not be immune to Hail"
    );
    assert!(
        !hail_immune(Affinity::Plant),
        "Plant must not be immune to Hail"
    );
}

// ---------------------------------------------------------------------------
// TEST: WEATHER_DEFAULT_TURNS is exactly 5
//
// Kills: an impl that sets WEATHER_DEFAULT_TURNS to a different value.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses a different default turn count (e.g. 3 or 8).
#[test]
fn weather_default_turns_is_five() {
    assert_eq!(
        WEATHER_DEFAULT_TURNS, 5,
        "TEETH: WEATHER_DEFAULT_TURNS must be 5 per ADR-0095; \
         an impl using 3 or 8 fails this known-answer check"
    );
}
