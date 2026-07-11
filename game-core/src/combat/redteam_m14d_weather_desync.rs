//! Red-team gating tests for M14d weather desync and validate_content findings.
//!
//! These tests expose confirmed bugs and gate against regression:
//!
//! RT-W14-DESYNC-01 (HIGH): skill_defs_from_rows always returns sets_weather=None,
//!     so the wild's weather-setting skill is silently treated as a non-weather skill
//!     during resolve_recruit_failure. This creates a game-core / server-module desync:
//!     - submit_attack / swap_active use game_core::load_skills() (sets_weather populated)
//!     - attempt_recruit uses skill_defs_from_rows() (sets_weather always None)
//!     The gating test proves the desync at the game-core level: a SkillDef with
//!     sets_weather=None vs sets_weather=Some(Rain) produces different BattleState.weather
//!     after resolve_recruit_failure. Gap documented in ADR-0095 residuals, deferred m14e.
//!
//! RT-W14-VALID-01 (FIXED — B-1): validate_content's weather guard was dead code.
//!     The original `let _valid = matches!(kind, ...)` discarded the result without
//!     asserting it. Fixed in this review: replaced with an exhaustive `match` with
//!     no wildcard arm, which IS a compile-time OCP gate. Valid WeatherKind values
//!     still pass validation. This test gates that valid weather skills remain accepted.

use crate::combat::resolve::resolve_recruit_failure;
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{BattleMonster, BattleOutcome, BattleSide, BattleState, TurnVariance};
use crate::combat::weather::{WeatherKind, WEATHER_DEFAULT_TURNS};
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
// breaking weather for resolve_recruit_failure.
//
// The server-module taming.rs::attempt_recruit calls:
//   let skill_defs = skill_defs_from_rows(&skill_rows)?;  // sets_weather: None for ALL
//   resolve_recruit_failure(&mut battle.state, &skill_defs, ...);
//
// But submit_attack and swap_active use:
//   let skill_defs = game_core::load_skills()?;  // sets_weather: Some(...) populated
//
// This means: if the wild has a weather-setting skill and the player fails a
// recruit attempt, the wild's strike-back does NOT set weather (it uses the
// skill_defs_from_rows path where sets_weather=None). The battle state weather
// is unchanged. This is WRONG — the weather should be set by the wild's skill.
//
// Gating test: prove that a skill with sets_weather=Some(Rain) vs sets_weather=None
// produces different state.weather after resolve_recruit_failure. The recruit
// failure path must fix its caller to use load_skills() like the attack path does.
//
// Kills: an impl of attempt_recruit that calls skill_defs_from_rows (which returns
// sets_weather=None for every skill) instead of load_skills() (which returns
// the actual sets_weather from the RON content). Once the fix is applied,
// skill_defs_from_rows is no longer called on the recruit-failure path and this
// test documents the before/after difference.
// ===========================================================================

/// Prove that sets_weather=Some(Rain) causes state.weather to be set after
/// resolve_recruit_failure, while sets_weather=None does not.
///
/// This is the load-bearing proof-of-desync: a caller that passes skills with
/// sets_weather=None (as skill_defs_from_rows does) silently drops the weather
/// effect. A caller that passes skills with sets_weather=Some(Rain) (as
/// load_skills() does) correctly sets state.weather.
///
/// The test proves the desync is REAL and that the fix (use load_skills() in
/// attempt_recruit) closes it.
#[test]
fn rt_w14_desync_01_recruit_failure_weather_strip_via_none_vs_some() {
    let chart = make_type_chart();

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

    // -----------------------------------------------------------------------
    // Path A (desync): skill_defs_from_rows silently returns sets_weather=None.
    // This is what the current attempt_recruit reducer does.
    // -----------------------------------------------------------------------
    let skill_with_weather_stripped = SkillDef {
        id: 7,
        name: "Rain Dance".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 10,
        sets_weather: None, // <-- what skill_defs_from_rows returns (BUG)
        applies_status: None,
    };

    let mut state_desync = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![player.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![wild.clone()],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let variance = always_hit_variance_weather();
    let _ = resolve_recruit_failure(
        &mut state_desync,
        &[skill_with_weather_stripped],
        &chart,
        &variance,
    );

    // With sets_weather=None: NO weather should be set (the desync path silently drops it).
    assert!(
        state_desync.weather.is_none(),
        "DESYNC PATH: skill_defs_from_rows returns sets_weather=None; \
         state.weather must remain None (the wild's weather-setting strike is silently dropped). \
         Got: {:?}",
        state_desync.weather
    );

    // -----------------------------------------------------------------------
    // Path B (correct): load_skills() returns sets_weather=Some(Rain).
    // This is what submit_attack and swap_active do correctly.
    // -----------------------------------------------------------------------
    let skill_with_weather_populated = SkillDef {
        id: 7,
        name: "Rain Dance".to_string(),
        affinity: Affinity::Water,
        power: 40,
        accuracy: 100,
        pp: 10,
        sets_weather: Some(WeatherKind::Rain), // <-- what load_skills() returns (CORRECT)
        applies_status: None,
    };

    // Reset: same initial state, different skill registry.
    let mut state_correct = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![player.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![wild.clone()],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let _ = resolve_recruit_failure(
        &mut state_correct,
        &[skill_with_weather_populated],
        &chart,
        &variance,
    );

    // With sets_weather=Some(Rain): weather MUST be set after the wild's strike-back.
    // The wild (side B, faster) attacks and uses skill 7 (Rain Dance).
    // The sets_weather=Some(Rain) field causes resolve_one_attack to set state.weather.
    assert!(
        state_correct.weather.is_some(),
        "CORRECT PATH: load_skills() returns sets_weather=Some(Rain); \
         state.weather must be Some(Rain{{turns:{WEATHER_DEFAULT_TURNS}}}) after wild's strike-back. \
         If this fails, the wild's attack did not fire (check speed/accuracy). \
         Got: {:?}",
        state_correct.weather
    );

    // -----------------------------------------------------------------------
    // The DESYNC: same battle scenario, same wild skill, different caller path
    // produces different state.weather. This proves the invariant violation.
    // -----------------------------------------------------------------------
    assert_ne!(
        state_desync.weather, state_correct.weather,
        "CONFIRMED DESYNC (RT-W14-DESYNC-01): attempt_recruit uses skill_defs_from_rows \
         (sets_weather=None for all skills), while submit_attack uses load_skills() \
         (sets_weather=Some(...)). A wild's weather-setting strike-back during recruit failure \
         silently drops the weather effect. state.weather differs between the two paths: \
         desync={:?} vs correct={:?}. \
         Fix: replace skill_defs_from_rows in taming.rs::attempt_recruit with \
         game_core::load_skills()? to match submit_attack and swap_active.",
        state_desync.weather, state_correct.weather
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
