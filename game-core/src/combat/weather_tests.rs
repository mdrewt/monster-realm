//! Weather / field state: damage modifiers, chip damage and immunities,
//! tick-down and expiry, skill-set weather (incl. the recruit-failure path)
//! and event ordering. One nested module per facet; each keeps its own fixtures.

pub mod field_state {
    //! Weather / field state: modifiers, chip, tick-down, skill-set weather, immunities.

    use crate::combat::ability::AbilityStore;
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

        let abilities = AbilityStore::new(1, 1);
        let events = resolve_full_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 7 },
            TurnChoice::Attack { skill_id: 7 },
            &skills,
            &chart,
            &variance,
            &mut status,
            &sv,
            &abilities,
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
                // unless the battle ended before tick.
                // With a 200-HP plant defender and level-5 Water attacker (attack=40, power=40),
                // the damage won't KO. So tick_weather WILL run, decrementing from 5 to 4.
                // both sides use skill_id=7 (Rain Dance). A goes first, sets Rain.
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
    // `sets_weather` fires AFTER the attack's damage is resolved.
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

        let abilities = AbilityStore::new(1, 1);
        let events_no_rain = resolve_full_turn(
            &mut state_no_rain,
            TurnChoice::Attack { skill_id: 7 }, // Rain Dance
            TurnChoice::Attack { skill_id: 7 }, // B also attacks but will miss
            &skills_with_rain_dance,
            &chart,
            &variance_a_first,
            &mut status_no_rain,
            &sv,
            &abilities,
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

        let abilities2 = AbilityStore::new(1, 1);
        let events_with_rain = resolve_full_turn(
            &mut state_with_rain,
            TurnChoice::Attack { skill_id: 2 }, // plain Water skill
            TurnChoice::Attack { skill_id: 2 }, // B misses
            &skills_plain,
            &chart,
            &variance_a_first,
            &mut status_with_rain,
            &sv,
            &abilities2,
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
}

pub mod chip_and_damage {
    //! Weather regression and hardening: byte-identical no-weather turns, chip cascades, known answers.

    use crate::combat::ability::AbilityStore;
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
    // M7 regression proof-of-teeth (LOAD-BEARING)
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
    /// weather event injected when weather=None produces an event that didn't come
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
        let abilities = AbilityStore::new(1, 1);
        let events_full = resolve_full_turn(
            &mut state_full,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
            &abilities,
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
    // Sandstorm chip on a 1-HP non-immune monster KOs it
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
    // Weather chip floor at tiny HP (max_hp=1)
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
    // Earth monster does NOT take Sandstorm chip
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
    // Water monster does NOT take Hail chip
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
    // Rain deals NO chip damage (attack modifier only)
    //
    // apply_weather_damage with Rain: no WeatherDamage events for either side
    // (Rain has no end-of-turn chip; it only modifies attack power).
    //
    // Kills: an impl that confuses Rain with Sandstorm/Hail and applies chip
    // to all non-immune monsters under Rain.
    // ===========================================================================

    /// Kills: an impl that applies chip damage under Rain — emitting WeatherDamage
    /// for non-immune monsters even though Rain has no end-of-turn chip.
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
    // Sun deals NO chip damage (attack modifier only)
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
    // Weather tick preserves weather until turns_remaining reaches 0
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
    // Rain attack modifier is applied after variance step
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

        let (dmg_no_weather, _) =
            calc_damage(&attacker, &defender, &water_skill, &chart, 100, None);
        let (dmg_rain, _) =
            calc_damage(&attacker, &defender, &water_skill, &chart, 100, Some(&rain));

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
    // Sun nerfs Water damage known-answer
    //
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

        let (dmg_no_weather, _) =
            calc_damage(&attacker, &defender, &water_skill, &chart, 100, None);
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
}

pub mod recruit_and_ordering {
    //! Weather on the recruit-failure path, validate_content coverage, and event ordering.
    //!
    //! RT-W14-DESYNC-01: attempt_recruit now uses
    //!     load_skills() (sets_weather/applies_status populated) instead of
    //!     skill_defs_from_rows() (sets_weather: None for all skills).
    //!     a wild's weather-setting strike-back
    //!     during resolve_recruit_failure must set state.weather when skills carry
    //!     sets_weather=Some(Rain) (as load_skills() returns).
    //!
    //! RT-W14-VALID-01: validate_content's weather guard was dead code.
    //!     The original `let _valid = matches!(kind, ...)` discarded the result without
    //!     asserting it. replaced with an exhaustive `match` with
    //!     no wildcard arm, which IS a compile-time OCP gate. Valid WeatherKind values
    //!     still pass validation. This test gates that valid weather skills remain accepted.

    use crate::combat::ability::AbilityStore;
    use crate::combat::resolve::resolve_recruit_failure;
    use crate::combat::status::{BattleStatusStore, StatusVariance};
    use crate::combat::type_chart::tests::make_type_chart;
    use crate::combat::types::{
        BattleMonster, BattleOutcome, BattleSide, BattleState, TurnVariance,
    };
    use crate::combat::weather::{WeatherEffect, WeatherKind, WEATHER_DEFAULT_TURNS};
    use crate::content::SkillDef;
    use crate::monster::types::{Affinity, StatBlock};

    // ---------------------------------------------------------------------------
    // Fixture helpers
    // ---------------------------------------------------------------------------

    fn make_stat_block_weather(attack: u16, defense: u16, speed: u16) -> StatBlock {
        StatBlock {
            hp: 100,
            attack,
            defense,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        }
    }

    fn make_monster_weather(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: hp,
            max_hp: hp,
            stats: make_stat_block_weather(40, 40, speed),
            known_skill_ids: vec![7], // skill id 7 is the weather-setting skill
            status: None,
        }
    }

    fn always_hit_variance_weather() -> TurnVariance {
        TurnVariance {
            damage_roll_a: 100,
            damage_roll_b: 100,
            accuracy_roll_a: 0,
            accuracy_roll_b: 0,
            speed_tie_breaker: false, // B (wild) faster
        }
    }

    // ===========================================================================
    // RT-W14-DESYNC-01 (HIGH): skill_defs_from_rows strips sets_weather, silently
    // FIXED: attempt_recruit now uses load_skills()
    // (sets_weather/applies_status populated). The desync is closed.
    //
    // Gating test: pin that a wild's weather-setting strike-back during
    // resolve_recruit_failure correctly sets state.weather when skills carry
    // sets_weather=Some(Rain) — as load_skills() returns.
    //
    // Kills: a regression that reverts attempt_recruit back to skill_defs_from_rows
    // (sets_weather=None), which would leave state.weather==None after the call and
    // fail the assertion below.
    // ===========================================================================

    /// RT-W14-DESYNC-01 (FIXED): pin that the recruit-failure path correctly sets
    /// weather when the wild uses a weather-setting skill.
    ///
    /// Before the fix: attempt_recruit used skill_defs_from_rows (sets_weather=None),
    /// so the wild's Rain Dance strike-back silently dropped the weather effect.
    /// After the fix: attempt_recruit uses load_skills() which returns
    /// sets_weather=Some(Rain), so state.weather is correctly set.
    ///
    /// This test pins the FIX: state.weather must be Some(Rain{turns:5}) after a
    /// wild with a Rain Dance skill strikes back during a failed recruit attempt.
    ///
    /// Kills: any regression that drops sets_weather (e.g. reverting to
    /// skill_defs_from_rows); state.weather would remain None and the assertion fails.
    #[test]
    fn rt_w14_desync_01_recruit_failure_weather_set_by_load_skills_path() {
        let chart = make_type_chart();
        let variance = always_hit_variance_weather();

        // Side A: player with high HP (survive the wild's strike-back).
        let player = BattleMonster {
            species_id: 1,
            affinity: Affinity::Fire,
            level: 10,
            current_hp: 500,
            max_hp: 500,
            stats: make_stat_block_weather(40, 40, 20), // slower than wild
            known_skill_ids: vec![1],
            status: None,
        };

        // Side B: wild that knows skill id 7 (the weather-setting skill).
        let wild = make_monster_weather(Affinity::Water, 200, 80); // faster than player

        // Skill with sets_weather=Some(Rain) — what load_skills() returns after the fix.
        let rain_dance = SkillDef {
            id: 7,
            name: "Rain Dance".to_string(),
            affinity: Affinity::Water,
            power: 40,
            accuracy: 100,
            pp: 10,
            sets_weather: Some(WeatherKind::Rain),
            applies_status: None,
        };

        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![player],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![wild],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };

        let mut status = BattleStatusStore::new(1, 1);
        let sv = StatusVariance {
            action_skip_roll_a: 99,
            action_skip_roll_b: 99,
            freeze_thaw_roll_a: 0,
            freeze_thaw_roll_b: 0,
            sleep_wake_roll_a: 0,
            sleep_wake_roll_b: 0,
        };

        let abilities = AbilityStore::new(1, 1);
        let _ = resolve_recruit_failure(
            &mut state,
            &[rain_dance],
            &chart,
            &variance,
            &mut status,
            &sv,
            &abilities,
        );

        // the wild (faster, B) attacks with Rain Dance (sets_weather=Some(Rain)).
        // Phase 5 weather tick then decrements turns_remaining from WEATHER_DEFAULT_TURNS to
        // WEATHER_DEFAULT_TURNS-1. Both D2 (load_skills set the weather) and D1 (post-turn
        // phases ran the tick) are proven by this assertion. A regression to skill_defs_from_rows
        // leaves state.weather=None here (sets_weather hardcoded to None in that path).
        const EXPECTED_TURNS: u8 = WEATHER_DEFAULT_TURNS - 1;
        assert!(
            matches!(
                state.weather,
                Some(WeatherEffect::Rain {
                    turns_remaining: EXPECTED_TURNS
                })
            ),
            "RT-W14-DESYNC-01 FIX PINNED: state.weather must be Rain{{turns:{EXPECTED_TURNS}}} \
         after wild's Rain Dance strike-back + weather tick (load_skills() path, \
         sets_weather=Some(Rain), then phase-5 tick). \
         A regression reverting to skill_defs_from_rows leaves state.weather=None here. \
         Got: {:?}",
            state.weather
        );
    }

    // ===========================================================================
    // RT-W14-VALID-01: validate_content accepts EVERY WeatherKind (runtime pin).
    //
    // WHAT CHANGED HERE, STATED PLAINLY. The previous version of
    // this test was named `..._weather_guard_is_vacuous` and carried a 25-line block
    // comment quoting a `let _valid = matches!(...)` in content.rs that NO LONGER EXISTS.
    // content.rs now uses an exhaustive `match` with no wildcard arm. The test's name and
    // its whole rationale asserted a defect the codebase had already fixed, so both were
    // deleted and the test rewritten as a positive pin.
    //
    // WHY REWRITE AND NOT DELETE: `validate_content` has 56 call sites including
    // sync_content_inner, and "content validation accepts every weather-setting skill" is a
    // live invariant that nothing else pins — every other validate_content test pins a
    // REJECTION. Deleting would have removed a lie at the cost of leaving real behaviour
    // unguarded.
    // ===========================================================================

    /// pin that `validate_content` ACCEPTS a skill setting
    /// each of the four `WeatherKind` variants at RUNTIME, one skill per case so a failure
    /// names the offending variant.
    ///
    /// HONEST SCOPE — read this before trusting the test for more than it proves:
    /// * What it pins: RUNTIME acceptance of `sets_weather: Some(k)` for every `k`.
    /// * What it does NOT pin: the OCP property. The open/closed gate for `WeatherKind` is
    ///   the COMPILER — an exhaustive `match` with no wildcard arm,
    ///   so a new variant is a compile error there. No runtime test can red the replacement
    ///   of that `match` with `_ => {}`.
    ///
    /// NEGATIVE CONTROL (mandatory, see the last case in the table): a positive `is_ok()`
    /// pin over inputs that structurally cannot be rejected is barely stronger than the
    /// vacuity it replaced — the whole-function mutant `validate_content(..) { Ok(()) }`
    /// survives it untouched. The final case is a weather-setting skill that is ALSO
    /// independently invalid (`power: 0`, rejected by the guard,
    /// which sits inside the same per-skill loop), asserted `is_err()`. That proves the RON
    /// fixture really reaches the skill-validation loop and kills the always-`Ok` mutant.
    #[test]
    fn rt_w14_valid_01_validate_content_accepts_every_weather_kind() {
        use crate::content::{parse_skills, parse_species, parse_type_chart, validate_content};

        // One species that learns exactly the one skill each case defines, so the
        // "learnable_skill_ids must exist" cross-check (content.rs:849-867) never fires and
        // cannot be confused with the weather guard.
        let species_ron = r#"[
        (id: 1, name: "A", base_stats: (hp:45,attack:49,defense:49,speed:65,sp_attack:65,sp_defense:45),
         affinity: Fire, learnable_skill_ids: [1])
    ]"#;
        let species = parse_species(species_ron).expect("species parse");
        let type_chart = parse_type_chart("[]").expect("type chart parse");
        let items = vec![];

        // ONE SKILL PER ITERATION, on purpose: a single 4-skill fixture returns one
        // Result and cannot name which variant was rejected.
        let cases = [
            (WeatherKind::Rain, "Rain"),
            (WeatherKind::Sun, "Sun"),
            (WeatherKind::Sandstorm, "Sandstorm"),
            (WeatherKind::Hail, "Hail"),
        ];

        let mut checked = 0usize;
        for (kind, name) in cases {
            // The table's own consistency, pinned cheaply: the RON below is built from the
            // STRING, so a mistyped pair would silently test the wrong variant four times.
            assert_eq!(
                format!("{kind:?}"),
                name,
                "RT-W14-VALID-01 table is inconsistent: WeatherKind::{kind:?} is paired with the \
             RON name {name:?}, so the fixture would not exercise the variant it claims to"
            );

            // power: 40 / accuracy: 100 keep the unrelated guards at content.rs:807-823
            // silent, so an `is_err()` here could only come from the weather cross-check.
            let skills_ron = format!(
                r#"[(id: 1, name: "WeatherMove", affinity: Water, power: 40, accuracy: 100, pp: 10, sets_weather: Some({name}))]"#
            );
            let skills = parse_skills(&skills_ron).expect("skills parse");

            let result = validate_content(&species, &skills, &type_chart, &items);
            assert!(
                result.is_ok(),
                "RT-W14-VALID-01: validate_content must ACCEPT a skill with \
             sets_weather: Some({name}) — every WeatherKind variant is legal content \
             (content.rs:824-834 is an exhaustive match whose arms all accept). \
             Rejected variant: {name}. Got: {result:?}"
            );
            checked += 1;
        }

        // ANTI-VACUITY: the loop must actually have run four times. A future edit that
        // empties the table would otherwise leave this test passing on nothing.
        assert_eq!(
            checked, 4,
            "RT-W14-VALID-01: all four WeatherKind variants must have been exercised; only \
         {checked} were. An empty/short table makes every assertion above unreachable."
        );

        // --- NEGATIVE CONTROL ---------------------------------------------------------
        // A weather-setting skill that is INDEPENDENTLY invalid: power == 0 is rejected by,
        // inside the same per-skill loop the weather match lives in.
        // Kills the whole-function mutant `validate_content(..) -> Result<(),String> {
        // Ok(()) }`, which every `is_ok()` assertion above survives, and proves the fixture
        // really reaches skill validation rather than short-circuiting somewhere earlier.
        let invalid_skills_ron = r#"[
        (id: 1, name: "Powerless Hail", affinity: Water, power: 0, accuracy: 100, pp: 10, sets_weather: Some(Hail))
    ]"#;
        let invalid_skills = parse_skills(invalid_skills_ron).expect("skills parse");
        let negative = validate_content(&species, &invalid_skills, &type_chart, &items);
        assert!(
            negative.is_err(),
            "RT-W14-VALID-01 NEGATIVE CONTROL: validate_content must REJECT a weather-setting \
         skill with power=0 (content.rs:807-812). If this is Ok, validate_content is not \
         validating skills at all — and every is_ok() assertion above is vacuous. Got: \
         {negative:?}"
        );
        let message = negative.unwrap_err();
        assert!(
            message.contains("power=0"),
            "RT-W14-VALID-01 NEGATIVE CONTROL: the rejection must come from the power guard \
         inside the per-skill loop (its message names power=0), not from some earlier \
         cross-check that would not prove the loop was reached. Got: {message}"
        );
    }

    // ===========================================================================
    // WeatherSet fires AFTER BattleEnd when a weather
    // move KOs the opponent on the same hit.
    //
    // When skill.sets_weather is Some AND the skill's damage KOs the defender,
    // resolve_one_attack emits:
    //   1. Damage { side: defender }
    //   2. Faint { side: defender }
    //   3. BattleEnd { winner: acting_side }
    //   4. WeatherSet { weather: Rain{turns:5} }   <-- AFTER BattleEnd
    //
    // The comment in resolve.rs says this is intentional:
    //   "Fires even if the move KOs (the weather still changes)."
    //
    // This means clients see a BattleEnd event before the WeatherSet. The weather
    // IS set in state.weather (the BattleState is mutated), but the battle is over.
    // On the NEXT load of the battle (if the row persists), state.weather shows Rain.
    // The client must handle: BattleEnd followed by WeatherSet gracefully.
    //
    // ===========================================================================

    /// Documents and gates the WeatherSet-after-BattleEnd ordering invariant.
    ///
    /// This test confirms the intentional design: a KO + weather-set skill emits
    /// BattleEnd BEFORE WeatherSet.
    ///
    /// If this test breaks (WeatherSet fires before BattleEnd), a regression was
    /// introduced in resolve_one_attack's ordering.
    #[test]
    fn rt_w14_ordering_01_weather_set_fires_after_battle_end_on_ko_turn() {
        use crate::combat::resolve::resolve_turn;
        use crate::combat::types::{BattleEvent, TurnChoice};
        use crate::combat::weather::WeatherEffect;

        let chart = make_type_chart();

        // Side A: strong attacker with a weather-setting Fire skill.
        let weather_move = SkillDef {
            id: 8,
            name: "Sunny Slam".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 10,
            sets_weather: Some(WeatherKind::Sun),
            applies_status: None,
        };

        let strong_attacker = BattleMonster {
            species_id: 1,
            affinity: Affinity::Fire,
            level: 50, // high level for large damage
            current_hp: 500,
            max_hp: 500,
            stats: StatBlock {
                hp: 500,
                attack: 255, // max attack → guaranteed KO
                defense: 50,
                speed: 100, // faster than defender
                sp_attack: 50,
                sp_defense: 50,
            },
            known_skill_ids: vec![8],
            status: None,
        };

        // Side B: extremely weak defender (1 HP) to guarantee KO.
        let weak_defender = BattleMonster {
            species_id: 2,
            affinity: Affinity::Plant, // Fire SE vs Plant → guaranteed KO
            level: 1,
            current_hp: 1, // 1 HP → any hit KOs
            max_hp: 1,
            stats: StatBlock {
                hp: 1,
                attack: 10,
                defense: 1, // minimum defense
                speed: 10,  // much slower than attacker
                sp_attack: 10,
                sp_defense: 1,
            },
            known_skill_ids: vec![8],
            status: None,
        };

        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![strong_attacker],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![weak_defender],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };

        let variance = TurnVariance {
            damage_roll_a: 100,
            damage_roll_b: 100,
            accuracy_roll_a: 0,  // always hits
            accuracy_roll_b: 99, // B misses (irrelevant — B won't act after being KO'd)
            speed_tie_breaker: true,
        };

        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 8 },
            TurnChoice::Attack { skill_id: 8 },
            &[weather_move],
            &chart,
            &variance,
        );

        // Find positions of BattleEnd and WeatherSet in the event stream.
        let battle_end_pos = events
            .iter()
            .position(|e| matches!(e, BattleEvent::BattleEnd { .. }));
        let weather_set_pos = events
            .iter()
            .position(|e| matches!(e, BattleEvent::WeatherSet { .. }));

        // Both must be present (the KO sets weather AND ends the battle).
        assert!(
            battle_end_pos.is_some(),
            "RT-W14-ORDERING-01: BattleEnd must be emitted when the KO terminates the battle"
        );
        assert!(
            weather_set_pos.is_some(),
            "RT-W14-ORDERING-01: WeatherSet must be emitted even on a KO turn (ADR-0095 D4: \
         weather fires AFTER damage+faint resolve)"
        );

        // WeatherSet fires AFTER BattleEnd (intentional design).
        // Clients must handle this ordering. If WeatherSet precedes BattleEnd,
        // the resolve_one_attack ordering was changed, breaking this invariant.
        let be = battle_end_pos.unwrap();
        let ws = weather_set_pos.unwrap();
        assert!(
            ws > be,
            "RT-W14-ORDERING-01 (ADR-0095 D4): WeatherSet must come AFTER BattleEnd \
         when the same attack both KOs and sets weather. \
         Got BattleEnd@{be}, WeatherSet@{ws}. Events: {events:?}. \
         If WeatherSet precedes BattleEnd, the ordering in resolve_one_attack changed."
        );

        // state.weather must be set even though the battle ended.
        assert!(
            state.weather.is_some(),
            "RT-W14-ORDERING-01: state.weather must be set even after a KO-ending turn \
         (the BattleState is mutated before GC via write_back_battle_results). \
         Got: {:?}",
            state.weather
        );
        assert!(
            matches!(
                state.weather,
                Some(WeatherEffect::Sun { turns_remaining: 5 })
            ),
            "RT-W14-ORDERING-01: state.weather must be Sun{{turns:5}} after Sunny Slam KO. \
         Got: {:?}",
            state.weather
        );

        // Outcome must be SideAWins.
        assert_eq!(
            state.outcome,
            BattleOutcome::SideAWins,
            "RT-W14-ORDERING-01: outcome must be SideAWins after A's weather move KOs B"
        );
    }
}
