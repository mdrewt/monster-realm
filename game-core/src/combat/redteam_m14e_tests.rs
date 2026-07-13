//! Red-team findings for the M14e status-applying skill + cure-item slice.
//!
//! Each test is a permanent gating test protecting a concrete adversarial invariant.
//! ALL tests start RED (compile error until BattleEvent::StatusApplied, SkillDef.applies_status,
//! ItemDef.cure_status, and the apply-status logic in resolve_full_turn exist).
//!
//! Findings summary (ranked by severity):
//!
//!   RT-M14E-01 (HIGH)   — Immune targets must NOT receive StatusApplied even when the
//!                          skill has applies_status set. An immune hit deals 0 damage
//!                          and must be treated like a complete miss for status purposes.
//!   RT-M14E-02 (HIGH)   — A skill that KOs the target AND has applies_status must NOT
//!                          emit StatusApplied (the target is fainted — applying a status
//!                          to a fainted monster is pointless and misleading to the client).
//!   RT-M14E-03 (MEDIUM) — Two separate skills both targeting the same slot in the same
//!                          turn (dual-status scenario): only the first application should
//!                          succeed; the second must be a no-op because the target is
//!                          already statused after the first attack resolves.
//!   RT-M14E-04 (MEDIUM) — Source-guard: use_battle_item must call require_owner (server
//!                          ownership guard). This is a security invariant — a player
//!                          must not be able to use an item on someone else's battle.

use crate::combat::ability::{AbilityStore, StatusKind};
use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::content::{SkillDef, TypeRelation};
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

/// Build a TypeChart where Fire→Water is Immune (effectiveness = 0).
/// This is a hand-crafted test chart, NOT the production type chart.
/// All other pairs default to neutral (10) because TypeChart::new uses
/// unlisted-pair → neutral semantics.
fn immune_type_chart() -> TypeChart {
    TypeChart::new(&[TypeRelation {
        attacker: Affinity::Fire,
        defender: Affinity::Water,
        effectiveness: 0, // immune
    }])
}

/// Standard neutral chart where every listed pair is neutral (or unlisted → neutral).
fn neutral_type_chart() -> TypeChart {
    TypeChart::new(&[]) // empty → all pairs neutral (10)
}

/// Always-hit, A-goes-first, minimum damage roll.
fn always_hit_variance() -> TurnVariance {
    TurnVariance {
        damage_roll_a: 85,
        damage_roll_b: 85,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    }
}

/// StatusVariance that never blocks and never thaws.
fn no_block_sv() -> StatusVariance {
    StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    }
}

/// A Burn-applying skill that hits SideA (Fire-type) against Water — immune.
fn burn_skill_fire_type() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Flamethrower".to_string(),
        affinity: Affinity::Fire,
        power: 90,
        accuracy: 100,
        pp: 15,
        sets_weather: None,
        // M14e adds this field — compile-RED until the field exists.
        applies_status: Some(StatusKind::Burn),
    }
}

/// A Poison-applying skill that always hits, neutral-type.
fn poison_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Poison Sting".to_string(),
        affinity: Affinity::Dark,
        power: 35,
        accuracy: 100,
        pp: 35,
        sets_weather: None,
        applies_status: Some(StatusKind::Poison),
    }
}

/// An extremely powerful KO skill (neutral type, very high power).
/// High attack stats + high power ensures the target faints even with max defense.
fn ohko_poison_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Annihilate".to_string(),
        affinity: Affinity::Dark,
        power: 250,
        accuracy: 100,
        pp: 5,
        sets_weather: None,
        applies_status: Some(StatusKind::Poison),
    }
}

fn make_monster_with_high_attack(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity,
        level: 50,
        current_hp: hp,
        max_hp: hp,
        stats: StatBlock {
            hp: 100,
            attack: 255,
            defense: 5,
            speed,
            sp_attack: 50,
            sp_defense: 5,
        },
        known_skill_ids: vec![1],
        status: None,
    }
}

// ---------------------------------------------------------------------------
// RT-M14E-01 (HIGH): Status NOT applied to Immune target
//
// When a Fire-type skill with applies_status=Some(Burn) hits a Water-type
// defender and the type chart has Fire→Water = Immune (0), the attack deals
// 0 damage AND must NOT emit StatusApplied. An immune hit has no effect —
// applying a status despite immunity is a rules violation.
//
// Kills: an impl that checks `applies_status` after the damage-and-faint
// block but BEFORE the Immune guard — emitting StatusApplied for Immune hits.
// The existing code in resolve_one_attack already returns early after Immune:
//   "if eff == Effectiveness::Immune { return; }"
// A wrong impl that applies status BEFORE that early-return would be caught here.
// ---------------------------------------------------------------------------

/// Kills: an impl that emits StatusApplied even when the hit is type-Immune —
/// the early-return-on-Immune path in resolve_one_attack must also skip status
/// application. A 0-damage Immune hit is NOT a successful application vector.
#[test]
fn rt_m14e_status_not_applied_to_immune_target() {
    // Fire-type skill with Burn application vs Water-type defender.
    // immune_type_chart() maps Fire→Water to Effectiveness::Immune (0 damage).
    let chart = immune_type_chart();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // Side A is Fire-type (skill affinity matches, gets STAB if relevant),
    // Side B is Water-type (immune to Fire attacks in our test chart).
    let monster_a = make_monster(Affinity::Fire, 200, 80); // faster
    let monster_b = make_monster(Affinity::Water, 200, 40); // immune to Fire
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = BattleStatusStore::new(1, 1);

    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass,
        &[burn_skill_fire_type()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // A Damage event with 0 damage (Immune) should appear, confirming the hit landed.
    let immune_damage = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Damage {
                side: SideId::SideB,
                amount: 0,
                ..
            }
        )
    });
    assert!(
        immune_damage,
        "RT-M14E-01: A Damage{{amount:0}} event for SideB should appear (Immune hit); \
         if this fails, the immune_type_chart fixture itself is broken and the test \
         cannot prove its invariant"
    );

    // NO StatusApplied must appear — Immune hits do not apply status.
    let status_applied_for_b = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });

    assert!(
        !status_applied_for_b,
        "RT-M14E-01 (HIGH): StatusApplied must NOT be emitted for an Immune target. \
         A Fire→Water Immune hit deals 0 damage — applying Burn despite immunity violates \
         the rules and confuses the client display. An impl that processes status \
         application BEFORE the Immune early-return emits StatusApplied here. \
         Got events: {events:?}"
    );

    // The BattleStatusStore must remain empty (no status was committed).
    assert!(
        status.side_b[0].is_none(),
        "RT-M14E-01 (HIGH): BattleStatusStore.side_b[0] must remain None after an \
         Immune hit — no status should be written to the store for an Immune target. \
         An impl that writes to the store before checking immunity would set Burn here."
    );
}

// ---------------------------------------------------------------------------
// RT-M14E-02 (HIGH): Status NOT applied after faint
//
// When a skill with applies_status KOs the target (target.current_hp reaches 0),
// the target is fainted and applying a status is pointless. No StatusApplied
// event should be emitted.
//
// The Faint event appears, BattleEnd appears, but NO StatusApplied.
//
// This is a HIGH finding because client display logic may use StatusApplied to
// show a status icon — showing a status icon on a fainted monster would be a
// UI bug / correctness issue.
//
// Kills: an impl that checks `applies_status` AFTER the faint/switch block
// using the post-faint state — the monster is dead but still gets a status
// event emitted (pointless, possibly harmful).
// ---------------------------------------------------------------------------

/// Kills: an impl that emits StatusApplied after the target faints from the
/// same attack — the fainted-target check must gate status application.
/// A fainted monster receiving a status event confuses client display logic.
#[test]
fn rt_m14e_status_not_applied_after_faint() {
    // Use an extremely strong attacker to guarantee KO even with minimum rolls.
    let chart = neutral_type_chart(); // all neutral — no type immunity
    let variance = TurnVariance {
        damage_roll_a: 100, // max roll for guaranteed KO
        damage_roll_b: 100,
        accuracy_roll_a: 0, // always hits
        accuracy_roll_b: 0,
        speed_tie_breaker: true, // A goes first
    };
    let sv = no_block_sv();

    // A has high attack + level 50, B has 1 HP — guaranteed KO by Poison Sting.
    let monster_a = make_monster_with_high_attack(Affinity::Dark, 5000, 80);
    let monster_b_base = make_monster(Affinity::Fire, 1, 40); // 1 HP → guaranteed KO
    let monster_b = BattleMonster {
        current_hp: 1,
        max_hp: 100,
        ..monster_b_base
    };

    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = BattleStatusStore::new(1, 1);

    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass,
        &[ohko_poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Faint for SideB must appear (confirming the KO happened).
    let faint_b = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Faint {
                side: SideId::SideB
            }
        )
    });
    assert!(
        faint_b,
        "RT-M14E-02: Faint{{side:SideB}} must appear after the KO; \
         if this fails, the ohko_poison_skill fixture or the monster setup is broken"
    );

    // BattleEnd must appear (B has no backup).
    let battle_end = events
        .iter()
        .any(|e| matches!(e, BattleEvent::BattleEnd { .. }));
    assert!(
        battle_end,
        "RT-M14E-02: BattleEnd must appear after a KO with no backup; \
         if missing, the fixture is broken"
    );

    // NO StatusApplied must appear for SideB (target is fainted).
    let status_applied_fainted = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });

    assert!(
        !status_applied_fainted,
        "RT-M14E-02 (HIGH): StatusApplied must NOT be emitted when the target faints \
         from the same attack. A fainted monster has no use for a status condition — \
         emitting StatusApplied after Faint is misleading to the client and indicates \
         the status-application logic doesn't check the post-damage faint state. \
         An impl that applies status in a separate post-attack phase (after the faint \
         check) without re-checking faint status fails here. \
         Got events: {events:?}"
    );

    // The BattleStatusStore must remain empty (no status committed for a fainted target).
    assert!(
        status.side_b[0].is_none(),
        "RT-M14E-02 (HIGH): BattleStatusStore.side_b[0] must remain None after the \
         target faints — committing a status to the store for a dead monster is wrong \
         and would cause spurious DoT events in future turns (if the battle continued)."
    );
}

// ---------------------------------------------------------------------------
// RT-M14E-03 (MEDIUM): No double-status same target in same turn
//
// Scenario: Both sides use Poison Sting (applies_status=Some(Poison)) and
// BOTH are fast enough to attack. Side A attacks first and applies Poison to B.
// Then Side B attacks A. After B's attack on A:
//   - A gets Poison (A had no status before B's attack)
// Meanwhile, if B had attacked A AND somehow applied status BACK to B (impossible
// in normal flow, but we test the "already statused from first hit" invariant):
//   - B must NOT receive Poison twice (B was statused by A's attack)
//
// This test also specifically validates the pre-attack snapshot: the "already
// statused" check MUST use the defender's status as it was BEFORE the attack,
// not the status mid-resolution.
//
// In practice this tests: after A poisons B, when B counter-attacks A, B is
// already poisoned — if there were any hypothetical second Poison application to B
// (e.g. from a weird "reflected" status), the no-stack rule would stop it.
//
// We test the concrete scenario: two mutual Poison Sting attacks in one turn.
// The result must be EXACTLY two StatusApplied events (one for each side), never
// three or more.
//
// Kills: an impl that double-applies status (e.g. applying it in both resolve_one_attack
// AND a separate post-resolution phase, causing the faster attacker's target to
// receive StatusApplied twice).
// ---------------------------------------------------------------------------

/// Kills: an impl that double-emits StatusApplied for the same side in the same turn
/// (e.g. from a bug where status application fires both in resolve_one_attack AND
/// in a separate post-resolution sweep over StatusApplied events).
#[test]
fn rt_m14e_no_double_status_same_target() {
    let chart = neutral_type_chart();
    let variance = TurnVariance {
        damage_roll_a: 85, // minimum roll — avoid KO on high-HP monsters
        damage_roll_b: 85,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true, // A goes first
    };
    let sv = no_block_sv();

    // Very high HP so neither side faints.
    let monster_a = make_monster(Affinity::Dark, 10000, 80); // faster
    let monster_b = make_monster(Affinity::Dark, 10000, 40); // slower

    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = BattleStatusStore::new(1, 1);

    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Count StatusApplied events for SideB (target of A's attack).
    let status_applied_b_count = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::StatusApplied {
                    side: SideId::SideB,
                    ..
                }
            )
        })
        .count();

    assert_eq!(
        status_applied_b_count, 1,
        "RT-M14E-03 (MEDIUM): SideB must receive EXACTLY ONE StatusApplied event, \
         not zero (A's Poison Sting must apply) and not two or more (double-apply bug). \
         An impl that applies status in resolve_one_attack AND again in a post-resolution \
         sweep over StatusApplied events would emit StatusApplied twice for SideB. \
         Got events: {events:?}"
    );

    // Count StatusApplied events for SideA (target of B's counter-attack).
    let status_applied_a_count = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::StatusApplied {
                    side: SideId::SideA,
                    ..
                }
            )
        })
        .count();

    assert_eq!(
        status_applied_a_count, 1,
        "RT-M14E-03 (MEDIUM): SideA must receive EXACTLY ONE StatusApplied event \
         from B's counter-attack. Got events: {events:?}"
    );

    // Total StatusApplied events must be exactly 2 (one per side).
    let total_status_applied = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusApplied { .. }))
        .count();

    assert_eq!(
        total_status_applied, 2,
        "RT-M14E-03 (MEDIUM): EXACTLY 2 StatusApplied events must appear in a \
         mutual-Poison-Sting turn (one for each side). Any other count indicates \
         double-application (>2) or missed application (<2). \
         Got {total_status_applied} events: {events:?}"
    );
}

// ---------------------------------------------------------------------------
// RT-M14E-04 (MEDIUM): use_battle_item must call require_owner — source guard
//
// The `use_battle_item` reducer must call `require_owner` to verify the caller
// owns the battle being modified. Without this check, any player could use
// items on another player's battle — a critical authorization gap.
//
// This is a SOURCE-GUARD test: it reads the text of battle.rs and verifies
// the body of `use_battle_item` contains a `require_owner` call.
//
// Why this pattern: reducers need ReducerContext to run, making pure unit tests
// infeasible. Source-guard tests (the established pattern in battle_tests.rs)
// are the canonical way to verify security invariants in server reducer code.
//
// Kills: an impl of use_battle_item that skips the ownership check — the reducer
// body would not contain `require_owner`, failing this assertion.
//
// RED state: use_battle_item does not exist yet in battle.rs, so extract_fn_body
// returns None and the .expect() panics → runtime-RED.
// ---------------------------------------------------------------------------

/// Source-guard test: use_battle_item body must contain `require_owner`.
///
/// Kills: any impl of use_battle_item that omits the ownership guard —
/// a player would then be able to use items on any battle, not just their own.
/// This is the authorization gate for the use_battle_item reducer.
///
/// RED state: use_battle_item does not exist in battle.rs → expect() panics.
#[test]
fn rt_m14e_use_battle_item_ownership_guard() {
    // Include battle.rs at compile time (same pattern as battle_tests.rs).
    // This file is game-core/src/combat/redteam_m14e_tests.rs; it is NOT
    // inside server-module/src/battle.rs, so there is no self-match risk.
    //
    // Note: this test lives in game-core but uses include_str! to read the
    // server-module file. The relative path from game-core/src/combat/ to
    // server-module/src/battle.rs requires going up several directory levels.
    // We use a path relative to this file's location.
    //
    // Alternative: this test would more naturally live in battle_tests.rs
    // (server-module), but the spec asks for it here in redteam_m14e_tests.rs
    // per the handoff instructions. We use the same include_str! + extract_fn_body
    // pattern, reading the correct path from this file's location.
    const BATTLE_SOURCE: &str = include_str!("../../../server-module/src/battle.rs");

    let stripped = strip_rust_comments(BATTLE_SOURCE);

    // Extract the body of use_battle_item. The function doesn't exist yet →
    // expect() panics → runtime-RED (desired state before implementation).
    // Assembled from parts so the literal `fn use_battle_item(` does not appear
    // in this test's own text (would confuse a future extract_fn_body call on
    // this file, which is NOT in battle.rs anyway — but the convention is clear).
    let fn_name = ["use", "_battle_item"].concat();
    let body = extract_fn_body(&stripped, &fn_name).expect(
        "TEETH (RT-M14E-04): use_battle_item must exist in server-module/src/battle.rs; \
         the function is missing — implement the reducer (RED state)",
    );

    // The body must contain a require_owner call (ownership guard).
    // Built from parts so the complete literal does not appear verbatim here
    // (convention consistency; no actual self-match risk since this file is not
    // inside battle.rs, but we follow the established pattern).
    let ownership_check = ["require", "_owner"].concat();

    assert!(
        body.contains(ownership_check.as_str()),
        "TEETH (RT-M14E-04 MEDIUM): use_battle_item body must call `require_owner` \
         to verify the caller owns the battle. Without this check, any player can \
         use items on another player's battle — an authorization gap. \
         Add `require_owner(ctx, battle.player_identity)?;` at the top of the reducer \
         body before any table mutations."
    );
}

// ---------------------------------------------------------------------------
// Shared comment-stripping and fn-body extraction helpers
// (mirrors the pattern in server-module/src/battle_tests.rs)
// ---------------------------------------------------------------------------

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from `src`.
/// Returns a new String with comment regions replaced by spaces.
///
/// Mirrors `strip_rust_comments` in server-module/src/battle_tests.rs.
fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of a named `fn` from `src` (comment-stripped).
///
/// Mirrors `extract_fn_body` in server-module/src/battle_tests.rs.
fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;

    let after_fn = &src[fn_start..];
    let brace_offset = after_fn.find('{')?;
    let body_start = fn_start + brace_offset + 1;

    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = src[body_start..].chars().collect();
    let mut char_pos = 0;
    while char_pos < chars.len() && depth > 0 {
        match chars[char_pos] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_pos].len_utf8();
        char_pos += 1;
    }

    if depth == 0 {
        Some(&src[body_start..body_start + rel])
    } else {
        None
    }
}
