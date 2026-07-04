//! M12a quest gating tests — proof-of-teeth for the quest/flag advance rules,
//! authored from the M12 spec §3 EARS criteria (ADR-0068 §"Proof-of-teeth").
//! Populated by the tester.
//!
//! EARS criteria covered:
//!   can_start_quest — start_conditions gating; already-active guard; already-done guard
//!   trigger_matches — Talk/Collect/Defeat exact match; qty threshold; type mismatch
//!   process_trigger — step advance; last-step → QuestComplete; reward correctness;
//!                     step-level conditions block advance even on matching trigger
//!
//! Each test carries a `/// kills:` comment naming which wrong implementation it
//! catches, so the verifier can match failing assertion → eliminated bug class.
//!
//! Red state: every test will PANIC on the `todo!()` stubs in `rules.rs`.
//!
//! Run: cargo nextest run -p game-core quest::m12a_gating_tests -- --nocapture

// &progress coercion from [T; N] to &[T] is flagged by clippy::needless_borrow
// in some Rust versions. Allow it so the fixture reads naturally.
#![allow(clippy::needless_borrow)]

use std::collections::BTreeSet;

use crate::dialogue::{Condition, PlayerDialogueState};
use crate::quest::{
    can_start_quest, process_trigger, trigger_matches, PlayerQuestProgress, QuestAdvance, QuestDef,
    QuestReward, QuestStep, RewardItem, StepTrigger, TriggerEvent,
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/// Empty player dialogue state — no flags, no active quests, no done quests.
fn empty_state() -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::new(),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    }
}

fn state_with_flag(flag: &str) -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::from([flag.to_string()]),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    }
}

fn state_with_done_quest(quest_id: &str) -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::new(),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::from([quest_id.to_string()]),
    }
}

/// A minimal one-step quest with no start conditions and a simple Talk trigger.
fn simple_one_step_quest(quest_id: &str, npc_id: &str) -> QuestDef {
    QuestDef {
        id: quest_id.to_string(),
        name: format!("Quest: {quest_id}"),
        start_conditions: vec![],
        steps: vec![QuestStep {
            trigger: StepTrigger::Talk {
                npc_id: npc_id.to_string(),
            },
            conditions: vec![],
        }],
        reward: QuestReward {
            xp: 50,
            items: vec![],
            currency: 0,
        },
    }
}

/// A two-step quest: step 0 = Talk("elder"), step 1 = Collect(item_id=1, qty=3).
fn two_step_quest() -> QuestDef {
    QuestDef {
        id: "two_step".to_string(),
        name: "Two Step Quest".to_string(),
        start_conditions: vec![],
        steps: vec![
            QuestStep {
                trigger: StepTrigger::Talk {
                    npc_id: "elder".to_string(),
                },
                conditions: vec![],
            },
            QuestStep {
                trigger: StepTrigger::Collect { item_id: 1, qty: 3 },
                conditions: vec![],
            },
        ],
        reward: QuestReward {
            xp: 100,
            items: vec![RewardItem { item_id: 1, qty: 3 }],
            currency: 0,
        },
    }
}

/// Progress record indicating the player is on a given step of a quest.
fn on_step(quest_id: &str, step_index: u32) -> PlayerQuestProgress {
    PlayerQuestProgress {
        quest_id: quest_id.to_string(),
        step_index,
    }
}

// ---------------------------------------------------------------------------
// CRITERION: can_start_quest
// ---------------------------------------------------------------------------

// Test 1 — No start_conditions + not active + not done → true
/// kills: an impl where can_start_quest always returns false (overly strict),
///        or one that always checks the active list incorrectly.
#[test]
fn can_start_quest_no_conditions_true() {
    let def = simple_one_step_quest("herb_run", "farmer");
    let state = empty_state();
    let progress: &[PlayerQuestProgress] = &[]; // no active quests

    assert!(
        can_start_quest(&def, &state, progress),
        "quest with no start_conditions and not yet active/done must be startable"
    );
}

// Test 2 — HasFlag start condition blocks when flag not set
/// kills: an impl that ignores start_conditions entirely (always returns true
///        regardless of player state).
#[test]
fn can_start_quest_condition_blocks() {
    let def = QuestDef {
        id: "elder_quest".to_string(),
        name: "Elder Quest".to_string(),
        start_conditions: vec![Condition::HasFlag("talked_elder".to_string())],
        steps: vec![QuestStep {
            trigger: StepTrigger::Talk {
                npc_id: "elder".to_string(),
            },
            conditions: vec![],
        }],
        reward: QuestReward {
            xp: 0,
            items: vec![],
            currency: 0,
        },
    };
    let state = empty_state(); // "talked_elder" NOT set
    let progress: &[PlayerQuestProgress] = &[];

    assert!(
        !can_start_quest(&def, &state, progress),
        "quest with HasFlag(\"talked_elder\") start condition must NOT be startable when flag absent"
    );
}

// Test 3 — HasFlag start condition met → true
/// kills: an impl that always returns false when start_conditions is non-empty
///        (incorrectly treating any conditions as always-blocking).
#[test]
fn can_start_quest_condition_met() {
    let def = QuestDef {
        id: "elder_quest".to_string(),
        name: "Elder Quest".to_string(),
        start_conditions: vec![Condition::HasFlag("talked_elder".to_string())],
        steps: vec![QuestStep {
            trigger: StepTrigger::Talk {
                npc_id: "elder".to_string(),
            },
            conditions: vec![],
        }],
        reward: QuestReward {
            xp: 0,
            items: vec![],
            currency: 0,
        },
    };
    let state = state_with_flag("talked_elder"); // condition is met
    let progress: &[PlayerQuestProgress] = &[];

    assert!(
        can_start_quest(&def, &state, progress),
        "quest with HasFlag(\"talked_elder\") start condition must be startable when flag is set"
    );
}

// Test 4 — False if quest is already in active progress (even if conditions met)
/// kills: an impl that doesn't check the active progress list in can_start_quest
///        — a player would be allowed to start the same quest twice, creating
///        duplicate progress entries.
///
/// PROOF-OF-TEETH: this is the primary bite fixture for the active-quest guard.
/// An impl with no progress check would return true here (conditions met, not done),
/// allowing double-start. The assert! below catches that.
#[test]
fn can_start_quest_false_if_already_active() {
    let def = simple_one_step_quest("herb_run", "farmer");
    let state = empty_state(); // conditions all met
    let progress = [on_step("herb_run", 0)]; // already on step 0

    assert!(
        !can_start_quest(&def, &state, &progress),
        "quest already in active progress must NOT be startable again (prevents double-start)"
    );
}

// Test 5 — False if quest is in done_quests (even if conditions met)
/// kills: an impl that doesn't check done_quests, allowing a player to replay
///        a completed quest and receive its rewards multiple times.
#[test]
fn can_start_quest_false_if_already_done() {
    let def = simple_one_step_quest("herb_run", "farmer");
    let state = state_with_done_quest("herb_run"); // "herb_run" in done_quests
    let progress: &[PlayerQuestProgress] = &[];

    assert!(
        !can_start_quest(&def, &state, &progress),
        "quest in done_quests must NOT be startable again (prevents reward replay)"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: trigger_matches
// ---------------------------------------------------------------------------

// Test 6 — Talk trigger matches Talked event with same npc_id
/// kills: an impl where trigger_matches always returns false, or one that
///        ignores the npc_id field and matches any Talked event.
#[test]
fn trigger_matches_talk_exact() {
    let trigger = StepTrigger::Talk {
        npc_id: "elder".to_string(),
    };
    let event = TriggerEvent::Talked {
        npc_id: "elder".to_string(),
    };
    assert!(
        trigger_matches(&trigger, &event),
        "Talk(\"elder\") must match Talked(\"elder\")"
    );
}

// Test 7 — Talk trigger does NOT match Talked event with different npc_id
/// kills: an impl where any Talked event satisfies any Talk trigger (npc_id
///        comparison missing or always true).
#[test]
fn trigger_matches_talk_wrong_npc() {
    let trigger = StepTrigger::Talk {
        npc_id: "elder".to_string(),
    };
    let event = TriggerEvent::Talked {
        npc_id: "innkeeper".to_string(),
    };
    assert!(
        !trigger_matches(&trigger, &event),
        "Talk(\"elder\") must NOT match Talked(\"innkeeper\")"
    );
}

// Test 8 — Collect trigger matches Collected event with exact item_id and qty
/// kills: an impl where Collect ignores item_id or qty, matching any collection.
#[test]
fn trigger_matches_collect_exact() {
    let trigger = StepTrigger::Collect { item_id: 1, qty: 3 };
    let event = TriggerEvent::Collected { item_id: 1, qty: 3 };
    assert!(
        trigger_matches(&trigger, &event),
        "Collect {{ item_id:1, qty:3 }} must match Collected {{ item_id:1, qty:3 }}"
    );
}

// Test 9 — Collect trigger does NOT match wrong item_id
/// kills: an impl that only checks qty but ignores item_id.
#[test]
fn trigger_matches_collect_wrong_item() {
    let trigger = StepTrigger::Collect { item_id: 1, qty: 3 };
    let event = TriggerEvent::Collected { item_id: 2, qty: 3 };
    assert!(
        !trigger_matches(&trigger, &event),
        "Collect {{ item_id:1, qty:3 }} must NOT match Collected {{ item_id:2, qty:3 }}"
    );
}

// Test 10 — Collect trigger does NOT match if event qty < required qty
/// kills: an impl where qty comparison is missing or uses `==` instead of `>=`,
///        accepting a partial collection as quest-complete.
#[test]
fn trigger_matches_collect_insufficient_qty() {
    let trigger = StepTrigger::Collect { item_id: 1, qty: 3 };
    let event = TriggerEvent::Collected { item_id: 1, qty: 2 }; // only 2, need 3
    assert!(
        !trigger_matches(&trigger, &event),
        "Collect {{ item_id:1, qty:3 }} must NOT match Collected {{ item_id:1, qty:2 }} \
         (qty 2 < required 3)"
    );
}

// Test 11 — Defeat trigger matches Defeated event with same species_id
/// kills: an impl where Defeat always returns false or ignores species_id.
#[test]
fn trigger_matches_defeat_exact() {
    let trigger = StepTrigger::Defeat { species_id: 5 };
    let event = TriggerEvent::Defeated { species_id: 5 };
    assert!(
        trigger_matches(&trigger, &event),
        "Defeat {{ species_id:5 }} must match Defeated {{ species_id:5 }}"
    );
}

// Test 12 — Type mismatch: Talk trigger vs Collected event → false
/// kills: an impl that only checks the payload fields and not the variant types
///        (e.g. npc_id="5" vs species_id=5 comparison somehow passes).
#[test]
fn trigger_matches_type_mismatch() {
    let trigger = StepTrigger::Talk {
        npc_id: "guard".to_string(),
    };
    let event = TriggerEvent::Collected { item_id: 1, qty: 1 };
    assert!(
        !trigger_matches(&trigger, &event),
        "Talk trigger must NOT match a Collected event (wrong variant type)"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: process_trigger
// ---------------------------------------------------------------------------

// Test 13 — Matching event advances to next step (StepComplete)
/// kills: an impl where process_trigger always returns None (never advances),
///        which would freeze all quest progression.
///
/// PROOF-OF-TEETH: a `fn process_trigger(...) -> Option<QuestAdvance> { None }`
/// stub fails here immediately. This is the primary tooth for quest advance.
#[test]
fn process_trigger_matching_event_advances_step() {
    let def = two_step_quest(); // 2 steps: Talk("elder") then Collect(1,3)
    let progress = on_step("two_step", 0); // on step 0 = Talk("elder")
    let event = TriggerEvent::Talked {
        npc_id: "elder".to_string(),
    };

    let result = process_trigger(&def, &progress, &empty_state(), &event);
    match result {
        Some(QuestAdvance::StepComplete { new_step }) => {
            assert_eq!(new_step, 1, "after completing step 0, new_step must be 1");
        }
        Some(QuestAdvance::QuestComplete { .. }) => {
            panic!("two-step quest on step 0 must not complete the quest on first trigger")
        }
        None => panic!(
            "matching Talked(\"elder\") on step 0 (Talk trigger) must return Some(StepComplete)"
        ),
    }
}

// Test 14 — Matching event on last step → QuestComplete with reward
/// kills: an impl that returns StepComplete even on the last step, never
///        reaching the QuestComplete branch and leaving the quest in limbo.
#[test]
fn process_trigger_last_step_completes_quest() {
    let def = simple_one_step_quest("herb_run", "farmer"); // 1 step only
    let progress = on_step("herb_run", 0); // on the only step (index 0)
    let event = TriggerEvent::Talked {
        npc_id: "farmer".to_string(),
    };

    let result = process_trigger(&def, &progress, &empty_state(), &event);
    match result {
        Some(QuestAdvance::QuestComplete { .. }) => {} // expected
        Some(QuestAdvance::StepComplete { new_step }) => panic!(
            "last step trigger must produce QuestComplete, not StepComplete(new_step={new_step})"
        ),
        None => panic!("matching event on last step must produce QuestComplete, not None"),
    }
}

// Test 15 — Matching quest active but wrong event type → None
/// kills: an impl that advances on any event regardless of whether the
///        trigger type matches.
#[test]
fn process_trigger_wrong_event_returns_none() {
    let def = simple_one_step_quest("herb_run", "farmer"); // step 0 = Talk("farmer")
    let progress = on_step("herb_run", 0);
    let event = TriggerEvent::Collected { item_id: 1, qty: 5 }; // wrong event type

    let result = process_trigger(&def, &progress, &empty_state(), &event);
    assert!(
        result.is_none(),
        "a Collected event must not advance a Talk-triggered step"
    );
}

// Test 16 — QuestComplete contains the correct reward
/// kills: an impl that returns an empty reward on QuestComplete, or one that
///        swaps reward fields (xp becomes item count, etc.).
#[test]
fn process_trigger_reward_correct() {
    let def = QuestDef {
        id: "reward_quest".to_string(),
        name: "Reward Quest".to_string(),
        start_conditions: vec![],
        steps: vec![QuestStep {
            trigger: StepTrigger::Talk {
                npc_id: "npc".to_string(),
            },
            conditions: vec![],
        }],
        reward: QuestReward {
            xp: 100,
            items: vec![RewardItem { item_id: 1, qty: 3 }],
            currency: 0,
        },
    };
    let progress = on_step("reward_quest", 0);
    let event = TriggerEvent::Talked {
        npc_id: "npc".to_string(),
    };

    let result = process_trigger(&def, &progress, &empty_state(), &event)
        .expect("matching event on last step must return Some");

    match result {
        QuestAdvance::QuestComplete { reward } => {
            assert_eq!(reward.xp, 100, "reward xp must be 100");
            assert_eq!(reward.items.len(), 1, "reward must have 1 item");
            assert_eq!(reward.items[0].item_id, 1, "reward item_id must be 1");
            assert_eq!(reward.items[0].qty, 3, "reward qty must be 3");
        }
        QuestAdvance::StepComplete { .. } => {
            panic!("single-step quest must produce QuestComplete on the only step")
        }
    }
}

// Test 17 — Step-level conditions block advance even when trigger matches
/// kills: an impl that ignores step.conditions and advances whenever the
///        trigger type and payload match — step conditions exist precisely to
///        add extra gates (e.g. a boss must be weakened before the kill counts).
///
/// PROOF-OF-TEETH: an impl with no step-condition check would return
/// Some(QuestComplete) here even though HasFlag("enemy_weakened") is unmet.
/// The assert!(result.is_none()) below catches that.
#[test]
fn process_trigger_step_conditions_block() {
    let def = QuestDef {
        id: "gated_step".to_string(),
        name: "Gated Step Quest".to_string(),
        start_conditions: vec![],
        steps: vec![QuestStep {
            trigger: StepTrigger::Defeat { species_id: 9 },
            conditions: vec![Condition::HasFlag("enemy_weakened".to_string())],
        }],
        reward: QuestReward {
            xp: 200,
            items: vec![],
            currency: 0,
        },
    };
    let progress = on_step("gated_step", 0);
    let event = TriggerEvent::Defeated { species_id: 9 }; // trigger matches
    let state = empty_state(); // BUT "enemy_weakened" flag is NOT set

    let result = process_trigger(&def, &progress, &state, &event);
    assert!(
        result.is_none(),
        "step with unmet condition HasFlag(\"enemy_weakened\") must block advance \
         even when the Defeat trigger matches — an impl ignoring step.conditions fails here"
    );
}

// Test 18 — Red-team RT-COLLECT-QTY0: Collect trigger with qty=0 in a step is satisfied
//           by ANY collection event with qty >= 0 — i.e. a zero-qty collect is always true.
//           The invariant: `validate_content` (M12c) MUST reject a step with Collect { qty: 0 }.
//           This test pins the CURRENT behaviour so if `trigger_matches` is ever hardened to
//           reject qty=0 triggers at the rule layer, the test author must update it deliberately.
//
/// kills: a future claim that "Collect{qty:0} is already safe" — it is NOT; the qty>=0 check
///        is vacuously true for any event, making the step free to complete.
#[test]
fn trigger_matches_collect_zero_qty_is_vacuously_true() {
    // A step requiring 0 items — content authoring error, but currently legal at the rule layer.
    let trigger = StepTrigger::Collect {
        item_id: 42,
        qty: 0,
    };
    // A Collected event that also carries qty=0 (player "collected nothing").
    let event = TriggerEvent::Collected {
        item_id: 42,
        qty: 0,
    };
    // The rule: eq >= tq ↔ 0 >= 0 = true → step is completed for free.
    assert!(
        trigger_matches(&trigger, &event),
        "trigger_matches(Collect{{qty:0}}, Collected{{qty:0}}) must return true \
         (0 >= 0 is vacuously true); this confirms M12c validate_content must \
         reject Collect steps with qty=0 to prevent free step completion"
    );
}

// Test 19 — Collect trigger with qty=0 is also satisfied by a non-zero event
/// kills: a false assumption that only qty=0 events satisfy the zero trigger — ANY
///        event satisfies it because the condition is `event.qty >= 0` which is always true.
#[test]
fn trigger_matches_collect_zero_qty_satisfied_by_any_nonzero_event() {
    let trigger = StepTrigger::Collect { item_id: 7, qty: 0 };
    let event = TriggerEvent::Collected {
        item_id: 7,
        qty: 100,
    };
    assert!(
        trigger_matches(&trigger, &event),
        "Collect{{qty:0}} step must be satisfied by any Collected event (100 >= 0 is true); \
         this is a content-validation gap — M12c MUST guard against qty=0 Collect steps"
    );
}

// Test 20 — Quest with multiple reward items: all appear in QuestComplete reward
/// kills: an impl that only includes the first item in the reward, or one that
///        truncates the items Vec during the clone/move into QuestAdvance.
#[test]
fn quest_complete_reward_items_are_all_present() {
    let def = QuestDef {
        id: "multi_reward".to_string(),
        name: "Multi Reward Quest".to_string(),
        start_conditions: vec![],
        steps: vec![QuestStep {
            trigger: StepTrigger::Talk {
                npc_id: "king".to_string(),
            },
            conditions: vec![],
        }],
        reward: QuestReward {
            xp: 500,
            items: vec![
                RewardItem { item_id: 1, qty: 1 },
                RewardItem { item_id: 7, qty: 5 },
                RewardItem {
                    item_id: 12,
                    qty: 2,
                },
            ],
            currency: 0,
        },
    };
    let progress = on_step("multi_reward", 0);
    let event = TriggerEvent::Talked {
        npc_id: "king".to_string(),
    };

    let result = process_trigger(&def, &progress, &empty_state(), &event)
        .expect("matching event on last step must return Some");

    match result {
        QuestAdvance::QuestComplete { reward } => {
            assert_eq!(reward.xp, 500, "reward xp must be 500");
            assert_eq!(
                reward.items.len(),
                3,
                "reward must contain all 3 items, got {}",
                reward.items.len()
            );
            // All item_ids present (order must be preserved)
            assert_eq!(reward.items[0].item_id, 1);
            assert_eq!(reward.items[1].item_id, 7);
            assert_eq!(reward.items[2].item_id, 12);
            assert_eq!(reward.items[1].qty, 5, "second item qty must be 5");
        }
        QuestAdvance::StepComplete { .. } => {
            panic!("single-step quest must produce QuestComplete")
        }
    }
}
