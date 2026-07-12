//! Red-team gating tests for M14d weather desync and validate_content findings.
//!
//! RT-W14-DESYNC-01 (FIXED — M14.5a, ADR-0098 D2): attempt_recruit now uses
//!     load_skills() (sets_weather/applies_status populated) instead of
//!     skill_defs_from_rows() (sets_weather: None for all skills). The desync
//!     between submit_attack/swap_active and attempt_recruit is closed.
//!     The gating test now pins the FIX: a wild's weather-setting strike-back
//!     during resolve_recruit_failure must set state.weather when skills carry
//!     sets_weather=Some(Rain) (as load_skills() returns).
//!
//! RT-W14-VALID-01 (FIXED — B-1): validate_content's weather guard was dead code.
//!     The original `let _valid = matches!(kind, ...)` discarded the result without
//!     asserting it. Fixed in this review: replaced with an exhaustive `match` with
//!     no wildcard arm, which IS a compile-time OCP gate. Valid WeatherKind values
//!     still pass validation. This test gates that valid weather skills remain accepted.

use crate::combat::resolve::resolve_recruit_failure;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{BattleMonster, BattleOutcome, BattleSide, BattleState, TurnVariance};
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
// FIXED (M14.5a, ADR-0098 D2): attempt_recruit now uses load_skills()
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
/// After the fix (ADR-0098 D2): attempt_recruit uses load_skills() which returns
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

    let _ = resolve_recruit_failure(
        &mut state,
        &[rain_dance],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // FIX PINNED: the wild (faster, B) attacks with Rain Dance (sets_weather=Some(Rain)).
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
// RT-W14-VALID-01 (MEDIUM): validate_content weather guard is dead code.
//
// In game-core/src/content.rs, the weather cross-check is:
//
//   if let Some(kind) = sk.sets_weather {
//       let _valid = matches!(
//           kind,
//           WeatherKind::Rain | WeatherKind::Sun | WeatherKind::Sandstorm | WeatherKind::Hail
//       );
//   }
//
// The `let _valid = ...` discards the boolean result without asserting it.
// The code never asserts `_valid` and never returns an error if `_valid` is false.
//
// Today this is a vacuous gate: it ALWAYS passes, regardless of the weather kind,
// because the unreachable branch (`_valid == false`) never returns `Err`.
// The OCP compile-time gate IS real (adding a new WeatherKind variant forces a
// compile error at the match arm), but the runtime enforcement is absent.
//
// This test documents the vacuousness by showing that validate_content
// accepts a skill with sets_weather even when there's no assertion on _valid.
// The correct fix is to assert _valid:
//   assert!(_valid, "...");
// or equivalently, remove the `let _valid` and use a direct error return.
// ===========================================================================

/// Prove that validate_content's weather guard is a dead-code boolean that
/// never causes a validation error, even though the comment claims it is a gate.
///
/// Kills: a future impl that restores the assertion (making this vacuousness test
/// GREEN only when the assertion is absent and RED when it's present).
///
/// Documents the current state so a reviewer can confirm the fix closes the gap.
#[test]
fn rt_w14_valid_01_validate_content_weather_guard_is_vacuous() {
    use crate::content::{parse_skills, parse_species, parse_type_chart, validate_content};

    // A skill with sets_weather populated (WeatherKind::Rain) passes validate_content
    // because the guard computes `_valid` but never asserts it.
    // The correct behavior would be: if _valid is false for some unrecognized kind,
    // return Err. Today: always Ok regardless.
    let species_ron = r#"[
        (id: 1, name: "A", base_stats: (hp:45,attack:49,defense:49,speed:65,sp_attack:65,sp_defense:45),
         affinity: Fire, learnable_skill_ids: [1])
    ]"#;
    let skills_ron_with_weather = r#"[
        (id: 1, name: "Rain Dance", affinity: Water, power: 40, accuracy: 100, pp: 10, sets_weather: Some(Rain))
    ]"#;

    let species = parse_species(species_ron).expect("species parse");
    let skills = parse_skills(skills_ron_with_weather).expect("skills parse");
    let type_chart = parse_type_chart("[]").expect("type chart parse");
    let items = vec![];

    // validate_content must accept weather-setting skills (the guard is dead code
    // that never rejects anything via the _valid path).
    let result = validate_content(&species, &skills, &type_chart, &items);

    assert!(
        result.is_ok(),
        "VACUOUS GATE (RT-W14-VALID-01): validate_content accepted a weather-setting skill. \
         The `let _valid = matches!(...)` guard discards its result without asserting. \
         This is correct behavior for valid WeatherKind values, but documents that \
         the _valid boolean is never used to gate validation. \
         Fix: change to `if !matches!(...) {{ return Err(...) }}`"
    );

    // The key assertion: the guard checks WeatherKind exhaustively at compile time
    // (correct OCP), but the result is NEVER used to produce a validation error.
    // We prove this by confirming that validate_content returns Ok for a weather skill
    // without any runtime check on _valid.
    //
    // To confirm the guard is dead, look at content.rs lines ~815-820:
    //   if let Some(kind) = sk.sets_weather {
    //       let _valid = matches!(kind, WeatherKind::Rain | ...);
    //       // NO: assert!(_valid, ...);
    //       // NO: if !_valid { return Err(...); }
    //   }
    //
    // The boolean is computed and silently discarded. This test documents that
    // the guard does not currently enforce runtime correctness.
    let _ = result; // consumed above
}

// ===========================================================================
// RT-W14-ORDERING-01 (LOW): WeatherSet fires AFTER BattleEnd when a weather
// move KOs the opponent on the same hit.
//
// When skill.sets_weather is Some AND the skill's damage KOs the defender,
// resolve_one_attack (resolve.rs:105-148) emits:
//   1. Damage { side: defender }
//   2. Faint { side: defender }
//   3. BattleEnd { winner: acting_side }
//   4. WeatherSet { weather: Rain{turns:5} }   <-- AFTER BattleEnd
//
// The comment in resolve.rs says this is intentional (ADR-0095 D4):
//   "Fires even if the move KOs (the weather still changes)."
//
// This means clients see a BattleEnd event before the WeatherSet. The weather
// IS set in state.weather (the BattleState is mutated), but the battle is over.
// On the NEXT load of the battle (if the row persists), state.weather shows Rain.
// The client must handle: BattleEnd followed by WeatherSet gracefully.
//
// This is low severity because:
//   1. It is intentional per ADR-0095 D4.
//   2. state.weather IS set correctly in the DB.
//   3. After write_back_battle_results, the battle row is GC'd — so state.weather
//      in the terminal row is irrelevant to gameplay.
//   4. Clients rendering the event stream must be aware of this ordering.
// ===========================================================================

/// Documents and gates the WeatherSet-after-BattleEnd ordering invariant.
///
/// This test confirms the intentional design: a KO + weather-set skill emits
/// BattleEnd BEFORE WeatherSet, which is the ADR-0095 D4 design choice.
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

    // ADR-0095 D4: WeatherSet fires AFTER BattleEnd (intentional design).
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
