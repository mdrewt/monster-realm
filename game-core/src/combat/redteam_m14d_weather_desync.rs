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

use crate::combat::ability::AbilityStore;
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
// RT-W14-VALID-01: validate_content accepts EVERY WeatherKind (runtime pin).
//
// 11r-h (ADR-0172 D5) — WHAT CHANGED HERE, STATED PLAINLY. The previous version of
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

/// RT-W14-VALID-01 (rewritten): pin that `validate_content` ACCEPTS a skill setting
/// each of the four `WeatherKind` variants at RUNTIME, one skill per case so a failure
/// names the offending variant.
///
/// HONEST SCOPE — read this before trusting the test for more than it proves:
/// * What it pins: RUNTIME acceptance of `sets_weather: Some(k)` for every `k`.
/// * What it does NOT pin: the OCP property. The open/closed gate for `WeatherKind` is
///   the COMPILER — `content.rs:824-834` is an exhaustive `match` with no wildcard arm,
///   so a new variant is a compile error there. No runtime test can red the replacement
///   of that `match` with `_ => {}`. The old doc-comment claimed a runtime gate; this
///   one does not.
///
/// NEGATIVE CONTROL (mandatory, see the last case in the table): a positive `is_ok()`
/// pin over inputs that structurally cannot be rejected is barely stronger than the
/// vacuity it replaced — the whole-function mutant `validate_content(..) { Ok(()) }`
/// survives it untouched. The final case is a weather-setting skill that is ALSO
/// independently invalid (`power: 0`, rejected by the guard at content.rs:807-812,
/// which sits inside the same per-skill loop), asserted `is_err()`. That proves the RON
/// fixture really reaches the skill-validation loop and kills the always-`Ok` mutant.
///
/// NOTE FOR A VERIFIER MUTATING content.rs: `content.rs:828-833` is a SINGLE COMBINED
/// arm (`Rain | Sun | Sandstorm | Hail => {}`). A kill mutation must SPLIT the arm
/// first, e.g. `WeatherKind::Hail => return Err("mutant".to_string()),` — then this test
/// reds naming Hail. Sibling reds from `validate_content_passes_for_embedded` are
/// expected collateral; the required signal is THIS test reding with the variant named.
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
    // A weather-setting skill that is INDEPENDENTLY invalid: power == 0 is rejected by
    // content.rs:807-812, inside the same per-skill loop the weather match lives in.
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
