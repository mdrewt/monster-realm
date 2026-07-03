//! M12a dialogue gating tests — proof-of-teeth for the dialogue model and
//! evaluation rules, authored from the M12 spec §3 EARS criteria (ADR-0068
//! §"Proof-of-teeth"). Populated by the tester.
//!
//! EARS criteria covered:
//!   Condition evaluation — HasFlag, NotFlag, QuestActive, QuestDone (all four variants)
//!   Entry node selection — first-matching, no-conditions baseline, all-blocked → None
//!   Available choices filtering — unconditional, gated by condition, multi-condition AND
//!   apply_choice — success result, out-of-range error, unavailable-choice error
//!   apply_effects — SetFlag, ClearFlag, StartQuest; GrantXp/GrantItem preserved but not applied
//!   Determinism — same tree + state → same available_choices
//!
//! Each test carries a `/// kills:` comment naming which wrong implementation it
//! catches, so the verifier can match failing assertion → eliminated bug class.
//!
//! Red state: every test will PANIC on the `todo!()` stubs in `rules.rs`.
//!
//! Run: cargo nextest run -p game-core dialogue::m12a_gating_tests -- --nocapture

// ChoiceResult is imported for use in the test module's type-level assertions;
// clippy sees it as unused because the tests use it only through apply_choice's
// return type (which is inferred). Allow it so the import documents the API surface.
#![allow(unused_imports)]

use std::collections::BTreeSet;

use crate::dialogue::{
    apply_choice, apply_effects, apply_node_auto_effects, available_choices, evaluate_condition,
    find_entry_node, ChoiceResult, Condition, DialogueChoice, DialogueEffect, DialogueError,
    DialogueNode, DialogueTree, PlayerDialogueState,
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/// Empty player state — no flags, no quests.
fn empty_state() -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::new(),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    }
}

/// State with a single flag set.
fn state_with_flag(flag: &str) -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::from([flag.to_string()]),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    }
}

/// State with a single active quest.
fn state_with_active_quest(quest_id: &str) -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::new(),
        active_quests: BTreeSet::from([quest_id.to_string()]),
        done_quests: BTreeSet::new(),
    }
}

/// State with a single done quest.
fn state_with_done_quest(quest_id: &str) -> PlayerDialogueState {
    PlayerDialogueState {
        flags: BTreeSet::new(),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::from([quest_id.to_string()]),
    }
}

/// A minimal unconditional choice with no effects and no next node.
fn unconditional_choice(text: &str) -> DialogueChoice {
    DialogueChoice {
        text: text.to_string(),
        conditions: vec![],
        effects: vec![],
        next_node: None,
    }
}

/// A minimal dialogue node with no entry conditions and no auto effects.
fn simple_node(id: &str, text: &str, choices: Vec<DialogueChoice>) -> DialogueNode {
    DialogueNode {
        id: id.to_string(),
        text: text.to_string(),
        entry_conditions: vec![],
        auto_effects: vec![],
        choices,
    }
}

/// A minimal dialogue node with one entry condition.
fn gated_node(id: &str, text: &str, cond: Condition) -> DialogueNode {
    DialogueNode {
        id: id.to_string(),
        text: text.to_string(),
        entry_conditions: vec![cond],
        auto_effects: vec![],
        choices: vec![],
    }
}

/// A minimal tree with a single root node.
fn single_node_tree(node: DialogueNode) -> DialogueTree {
    let root_id = node.id.clone();
    DialogueTree {
        id: "tree_1".to_string(),
        root_node_id: root_id,
        nodes: vec![node],
    }
}

// ---------------------------------------------------------------------------
// CRITERION: Condition evaluation — HasFlag
// ---------------------------------------------------------------------------

// Test 1 — HasFlag with flag present → true
/// kills: an impl where evaluate_condition(HasFlag) always returns false,
///        blocking every flag-gated dialogue path.
#[test]
fn evaluate_condition_has_flag_true() {
    let state = state_with_flag("talked_elder");
    let cond = Condition::HasFlag("talked_elder".to_string());
    assert!(
        evaluate_condition(&cond, &state),
        "HasFlag(\"talked_elder\") must return true when flag is in state.flags"
    );
}

// Test 2 — HasFlag with flag absent → false
/// kills: an impl where evaluate_condition(HasFlag) always returns true,
///        granting access to every flag-gated choice regardless of state.
#[test]
fn evaluate_condition_has_flag_false() {
    let state = empty_state(); // no flags
    let cond = Condition::HasFlag("talked_elder".to_string());
    assert!(
        !evaluate_condition(&cond, &state),
        "HasFlag(\"talked_elder\") must return false when flag is NOT in state.flags"
    );
}

// Test 3 — NotFlag with flag absent → true
/// kills: an impl where NotFlag is treated as HasFlag (inverted logic missing).
#[test]
fn evaluate_condition_not_flag_true() {
    let state = empty_state(); // quest_done flag NOT present
    let cond = Condition::NotFlag("quest_done".to_string());
    assert!(
        evaluate_condition(&cond, &state),
        "NotFlag(\"quest_done\") must return true when flag is NOT in state.flags"
    );
}

// Test 4 — NotFlag with flag present → false
/// kills: an impl where NotFlag always returns true, making blocking conditions
///        ineffective (e.g. a one-time dialogue plays repeatedly).
#[test]
fn evaluate_condition_not_flag_false() {
    let state = state_with_flag("quest_done");
    let cond = Condition::NotFlag("quest_done".to_string());
    assert!(
        !evaluate_condition(&cond, &state),
        "NotFlag(\"quest_done\") must return false when flag IS in state.flags"
    );
}

// Test 5 — QuestActive with quest in active_quests → true
/// kills: an impl that checks flags instead of active_quests for QuestActive.
#[test]
fn evaluate_condition_quest_active_true() {
    let state = state_with_active_quest("gather_herbs");
    let cond = Condition::QuestActive("gather_herbs".to_string());
    assert!(
        evaluate_condition(&cond, &state),
        "QuestActive(\"gather_herbs\") must return true when quest is in state.active_quests"
    );
}

// Test 6 — QuestActive with quest NOT active → false
/// kills: an impl where QuestActive always returns true, allowing mid-quest
///        dialogue even when the quest has not been started.
#[test]
fn evaluate_condition_quest_active_false() {
    let state = empty_state(); // gather_herbs NOT active
    let cond = Condition::QuestActive("gather_herbs".to_string());
    assert!(
        !evaluate_condition(&cond, &state),
        "QuestActive(\"gather_herbs\") must return false when quest is NOT in state.active_quests"
    );
}

// Test 7 — QuestDone with quest in done_quests → true
/// kills: an impl that checks active_quests instead of done_quests for QuestDone.
#[test]
fn evaluate_condition_quest_done_true() {
    let state = state_with_done_quest("main_quest");
    let cond = Condition::QuestDone("main_quest".to_string());
    assert!(
        evaluate_condition(&cond, &state),
        "QuestDone(\"main_quest\") must return true when quest is in state.done_quests"
    );
}

// Test 8 — QuestDone with quest NOT done → false
/// kills: an impl where QuestDone always returns true, making post-quest
///        dialogue available before the quest is finished.
#[test]
fn evaluate_condition_quest_done_false() {
    let state = empty_state(); // main_quest NOT done
    let cond = Condition::QuestDone("main_quest".to_string());
    assert!(
        !evaluate_condition(&cond, &state),
        "QuestDone(\"main_quest\") must return false when quest is NOT in state.done_quests"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: Entry node selection
// ---------------------------------------------------------------------------

// Test 9 — No entry conditions always matches any state
/// kills: an impl that treats an empty entry_conditions Vec as "always blocked"
///        instead of "always passes" (vacuous truth).
#[test]
fn find_entry_node_no_conditions_matches_any_state() {
    let node = simple_node("n1", "Hello traveller.", vec![]);
    let tree = single_node_tree(node);

    // Should match with empty state
    let result = find_entry_node(&tree, &empty_state());
    assert!(
        result.is_some(),
        "a node with no entry_conditions must always match regardless of player state"
    );
    assert_eq!(
        result.unwrap().id,
        "n1",
        "must return the unconditional node"
    );
}

// Test 10 — Entry condition gates the node: with flag set → shown; without → not shown
/// kills: an impl where entry_conditions are completely ignored (every node always matches).
#[test]
fn find_entry_node_condition_gates_node() {
    let node = gated_node(
        "n1",
        "Elder's greeting.",
        Condition::HasFlag("talked".to_string()),
    );
    let tree = single_node_tree(node);

    // Without the flag → no match
    let result_without = find_entry_node(&tree, &empty_state());
    assert!(
        result_without.is_none(),
        "node gated by HasFlag(\"talked\") must NOT match when flag is absent"
    );

    // With the flag → match
    let result_with = find_entry_node(&tree, &state_with_flag("talked"));
    assert!(
        result_with.is_some(),
        "node gated by HasFlag(\"talked\") must match when flag is set"
    );
    assert_eq!(result_with.unwrap().id, "n1");
}

// Test 11 — Returns the FIRST matching node (not second, not last)
/// kills: an impl that returns the last matching node, or one that ignores
///        ordering and returns an arbitrary match (flags-based entry branching
///        depends on declaration order as the priority mechanism).
#[test]
fn find_entry_node_returns_first_matching() {
    let first_node = gated_node(
        "n_gated",
        "You are known to me.",
        Condition::HasFlag("talked".to_string()),
    );
    let second_node = simple_node("n_open", "Greetings, stranger.", vec![]);
    let tree = DialogueTree {
        id: "tree_2".to_string(),
        root_node_id: "n_gated".to_string(),
        nodes: vec![first_node, second_node],
    };

    // Without flag → second (unconditional) node matches
    let result_no_flag = find_entry_node(&tree, &empty_state());
    assert_eq!(
        result_no_flag.map(|n| n.id.as_str()),
        Some("n_open"),
        "without flag, first gated node fails, second unconditional node must be returned"
    );

    // With flag → first (gated) node matches first
    let result_with_flag = find_entry_node(&tree, &state_with_flag("talked"));
    assert_eq!(
        result_with_flag.map(|n| n.id.as_str()),
        Some("n_gated"),
        "with flag, first node passes its condition and must be returned (first-match wins)"
    );
}

// Test 12 — None when all nodes have unmet entry conditions
/// kills: an impl that always returns the first node ignoring conditions,
///        or one that panics instead of returning None.
#[test]
fn find_entry_node_none_when_all_blocked() {
    let node_a = gated_node(
        "n_a",
        "Need flag_a.",
        Condition::HasFlag("flag_a".to_string()),
    );
    let node_b = gated_node(
        "n_b",
        "Need flag_b.",
        Condition::HasFlag("flag_b".to_string()),
    );
    let tree = DialogueTree {
        id: "tree_3".to_string(),
        root_node_id: "n_a".to_string(),
        nodes: vec![node_a, node_b],
    };

    let result = find_entry_node(&tree, &empty_state()); // neither flag set
    assert!(
        result.is_none(),
        "when all nodes have unmet entry_conditions, find_entry_node must return None"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: Available choices filtering
// ---------------------------------------------------------------------------

// Test 13 — All unconditional choices available
/// kills: an impl where available_choices always returns empty, or one that
///        requires explicit conditions for a choice to be shown.
#[test]
fn available_choices_all_unconditional() {
    let node = simple_node(
        "n1",
        "What would you like?",
        vec![
            unconditional_choice("Tell me about the town."),
            unconditional_choice("I must be going."),
        ],
    );

    let result = available_choices(&node, &empty_state());
    assert_eq!(
        result,
        vec![0, 1],
        "both unconditional choices must be available (indices [0, 1])"
    );
}

// Test 14 — Gated choice only available when condition met
/// kills: an impl where evaluate_condition(HasFlag) always returns true
///        regardless of state — the gated choice would appear when it should
///        not, breaking the flag-gate contract.
///
/// PROOF-OF-TEETH: this is the primary bite fixture for condition evaluation.
/// An impl with `fn evaluate_condition(...) -> bool { true }` would return
/// index [0] for the empty-state call here, failing the assert!(result.is_empty()).
#[test]
fn available_choices_filters_by_condition() {
    let gated_choice = DialogueChoice {
        text: "I know your secret.".to_string(),
        conditions: vec![Condition::HasFlag("talked".to_string())],
        effects: vec![],
        next_node: None,
    };
    let node = simple_node("n1", "Hello.", vec![gated_choice]);

    // Without flag → no choices available
    let result_no_flag = available_choices(&node, &empty_state());
    assert!(
        result_no_flag.is_empty(),
        "choice gated by HasFlag(\"talked\") must NOT appear when flag is absent; \
         an always-true evaluate_condition impl would fail here"
    );

    // With flag → choice available
    let result_with_flag = available_choices(&node, &state_with_flag("talked"));
    assert_eq!(
        result_with_flag,
        vec![0],
        "choice gated by HasFlag(\"talked\") must appear when flag is set"
    );
}

// Test 15 — Multiple conditions: ALL must hold (AND semantics)
/// kills: an impl that treats multiple conditions as OR (any one passing
///        would make the choice available), or one that only checks the first
///        condition and ignores the rest.
#[test]
fn available_choices_multiple_conditions_all_must_hold() {
    let multi_cond_choice = DialogueChoice {
        text: "I am ready.".to_string(),
        conditions: vec![
            Condition::HasFlag("a".to_string()),
            Condition::NotFlag("b".to_string()),
        ],
        effects: vec![],
        next_node: None,
    };
    let node = simple_node("n1", "Choose wisely.", vec![multi_cond_choice]);

    // Only "a" set, "b" absent — both conditions hold → available
    let state_both_hold = PlayerDialogueState {
        flags: BTreeSet::from(["a".to_string()]),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    };
    let result_both = available_choices(&node, &state_both_hold);
    assert_eq!(
        result_both,
        vec![0],
        "[HasFlag(a), NotFlag(b)]: when a=set and b=absent both conditions hold → choice available"
    );

    // Only "a" set, "b" also set — NotFlag("b") fails → not available
    let state_b_set = PlayerDialogueState {
        flags: BTreeSet::from(["a".to_string(), "b".to_string()]),
        active_quests: BTreeSet::new(),
        done_quests: BTreeSet::new(),
    };
    let result_b_set = available_choices(&node, &state_b_set);
    assert!(
        result_b_set.is_empty(),
        "[HasFlag(a), NotFlag(b)]: when b is also set, NotFlag(b) fails → choice unavailable \
         (an OR impl would still return [0] here)"
    );

    // Neither flag set → HasFlag("a") fails → not available
    let result_neither = available_choices(&node, &empty_state());
    assert!(
        result_neither.is_empty(),
        "[HasFlag(a), NotFlag(b)]: when a is absent, HasFlag(a) fails → choice unavailable"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: apply_choice
// ---------------------------------------------------------------------------

// Test 16 — Successful apply_choice returns effects and next_node
/// kills: an impl that returns Ok with empty effects, or one that always
///        returns None for next_node_id even when a next node is specified.
#[test]
fn apply_choice_success_returns_effects_and_next() {
    let choice = DialogueChoice {
        text: "I accept.".to_string(),
        conditions: vec![],
        effects: vec![DialogueEffect::SetFlag("accepted".to_string())],
        next_node: Some("n2".to_string()),
    };
    let node = simple_node("n1", "Will you help?", vec![choice]);
    let state = empty_state();

    let result = apply_choice(&node, 0, &state).expect("unconditional choice must succeed");

    assert_eq!(
        result.effects.len(),
        1,
        "result must contain the choice's 1 effect"
    );
    assert_eq!(
        result.next_node_id,
        Some("n2"),
        "next_node_id must be Some(\"n2\") as specified in the choice"
    );
}

// Test 17 — choice_idx >= choices.len() → Err(InvalidChoice)
/// kills: an impl that panics (unwrap/index-out-of-bounds) instead of returning
///        an error — panic is not a protocol; the server reducer must propagate Err.
#[test]
fn apply_choice_out_of_range_error() {
    let node = simple_node("n1", "Hello.", vec![unconditional_choice("Goodbye.")]);
    let state = empty_state();

    let result = apply_choice(&node, 5, &state); // index 5, only 1 choice
    match result {
        Err(DialogueError::InvalidChoice) => {} // expected
        other => panic!(
            "out-of-range choice_idx must return Err(InvalidChoice), got {:?}",
            other
        ),
    }
}

// Test 18 — Choice exists but condition not met → Err(ChoiceUnavailable)
/// kills: an impl that allows selecting any choice regardless of conditions —
///        a player could bypass NPC trust-gates by sending a raw choice index.
///
/// PROOF-OF-TEETH: this fixture directly kills the "no condition check in
/// apply_choice" bug class. An impl that calls `node.choices[choice_idx]` and
/// returns Ok without re-evaluating conditions would return Ok here instead of
/// Err(ChoiceUnavailable), failing the match arm below.
#[test]
fn apply_choice_unavailable_choice_error() {
    let gated_choice = DialogueChoice {
        text: "Secret option.".to_string(),
        conditions: vec![Condition::HasFlag("vip".to_string())],
        effects: vec![],
        next_node: None,
    };
    let node = simple_node("n1", "Hello.", vec![gated_choice]);
    let state = empty_state(); // "vip" flag NOT set

    let result = apply_choice(&node, 0, &state); // index in range, but condition not met
    match result {
        Err(DialogueError::ChoiceUnavailable) => {} // expected
        other => panic!(
            "selecting a choice whose conditions are not met must return \
             Err(ChoiceUnavailable), got {:?}",
            other
        ),
    }
}

// Test 19 — Choice with next_node=None ends dialogue
/// kills: an impl that always returns Some("") or panics on None next_node,
///        or one that defaults to the root node when next_node is None.
#[test]
fn apply_choice_none_next_node_ends_dialogue() {
    let choice = DialogueChoice {
        text: "Farewell.".to_string(),
        conditions: vec![],
        effects: vec![],
        next_node: None, // explicitly ends dialogue
    };
    let node = simple_node("n1", "Safe travels.", vec![choice]);
    let state = empty_state();

    let result = apply_choice(&node, 0, &state).expect("unconditional choice must succeed");
    assert!(
        result.next_node_id.is_none(),
        "apply_choice on a choice with next_node=None must return next_node_id=None (end dialogue)"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: apply_effects
// ---------------------------------------------------------------------------

// Test 20 — SetFlag adds the flag to state.flags
/// kills: an impl where SetFlag mutates the wrong field, or silently no-ops.
#[test]
fn apply_effects_set_flag() {
    let mut state = empty_state();
    apply_effects(&[DialogueEffect::SetFlag("x".to_string())], &mut state);
    assert!(
        state.flags.contains("x"),
        "SetFlag(\"x\") must add \"x\" to state.flags"
    );
}

// Test 21 — ClearFlag removes a flag; no-ops if flag absent
/// kills: an impl where ClearFlag panics when the flag is absent, or one that
///        clears the entire flags set instead of the specified flag.
#[test]
fn apply_effects_clear_flag() {
    // Remove a flag that is present
    let mut state = state_with_flag("x");
    apply_effects(&[DialogueEffect::ClearFlag("x".to_string())], &mut state);
    assert!(
        !state.flags.contains("x"),
        "ClearFlag(\"x\") must remove \"x\" from state.flags"
    );

    // No-op when flag is absent
    let mut state_empty = empty_state();
    apply_effects(
        &[DialogueEffect::ClearFlag("nonexistent".to_string())],
        &mut state_empty,
    );
    assert!(
        state_empty.flags.is_empty(),
        "ClearFlag on an absent flag must be a no-op (no panic, no flags changed)"
    );
}

// Test 22 — StartQuest adds quest to active_quests
/// kills: an impl where StartQuest adds to done_quests or flags instead of
///        active_quests.
#[test]
fn apply_effects_start_quest() {
    let mut state = empty_state();
    apply_effects(&[DialogueEffect::StartQuest("q1".to_string())], &mut state);
    assert!(
        state.active_quests.contains("q1"),
        "StartQuest(\"q1\") must add \"q1\" to state.active_quests"
    );
    assert!(
        !state.done_quests.contains("q1"),
        "StartQuest must NOT add to done_quests"
    );
    assert!(
        !state.flags.contains("q1"),
        "StartQuest must NOT add to flags"
    );
}

// Test 23 — GrantXp/GrantItem effects are preserved in ChoiceResult but NOT
//           applied to PlayerDialogueState (server applies them)
/// kills: an impl where apply_choice strips server-side effects from the result
///        (the server would then never see them and XP/items would be lost), or
///        one that panics when GrantXp/GrantItem appear in the effects list.
#[test]
fn apply_effects_grant_effects_preserved_in_choice() {
    let choice = DialogueChoice {
        text: "Take this.".to_string(),
        conditions: vec![],
        effects: vec![
            DialogueEffect::GrantXp(100),
            DialogueEffect::GrantItem(2, 3),
        ],
        next_node: None,
    };
    let node = simple_node("n1", "A gift for you.", vec![choice]);
    let mut state = empty_state();

    let result = apply_choice(&node, 0, &state).expect("unconditional choice must succeed");

    // Server-side effects must appear in the result unchanged
    assert_eq!(
        result.effects.len(),
        2,
        "ChoiceResult must contain all 2 effects (GrantXp + GrantItem)"
    );

    // apply_effects on those effects must NOT touch flags or quests
    apply_effects(result.effects, &mut state);
    assert!(
        state.flags.is_empty(),
        "GrantXp/GrantItem must not add anything to state.flags"
    );
    assert!(
        state.active_quests.is_empty(),
        "GrantXp/GrantItem must not add anything to state.active_quests"
    );
    assert!(
        state.done_quests.is_empty(),
        "GrantXp/GrantItem must not add anything to state.done_quests"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: Determinism
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CRITERION: apply_node_auto_effects (red-team F1 — M12b silent-drop trap)
// ---------------------------------------------------------------------------

// Test 24 — apply_node_auto_effects applies the node's auto_effects to state
/// kills: an M12b impl that calls find_entry_node but never calls apply_node_auto_effects —
///        all node-entry effects (SetFlag, StartQuest) would be silently discarded.
///
/// PROOF-OF-TEETH: any impl that skips apply_effects(&node.auto_effects, state) would leave
/// state.flags empty after node entry, failing the assert below.
#[test]
fn apply_node_auto_effects_applies_entry_effects() {
    let node = DialogueNode {
        id: "n1".to_string(),
        text: "The elder notices you.".to_string(),
        entry_conditions: vec![],
        auto_effects: vec![DialogueEffect::SetFlag("met_elder".to_string())],
        choices: vec![],
    };
    let mut state = empty_state();
    apply_node_auto_effects(&node, &mut state);
    assert!(
        state.flags.contains("met_elder"),
        "apply_node_auto_effects must apply auto_effects: SetFlag(\"met_elder\") must be in flags \
         — an impl that skips this call would leave flags empty"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: apply_effects idempotency (red-team F2 — completed-quest re-open)
// ---------------------------------------------------------------------------

// Test 25 — StartQuest on a completed quest is a no-op (idempotency guard)
/// kills: an impl where apply_effects re-inserts a done quest into active_quests,
///        allowing quest replay and duplicate reward granting through dialogue effects.
///
/// PROOF-OF-TEETH: an impl without the done_quests guard would insert q1 into
/// active_quests unconditionally, failing the assert!(!state.active_quests.contains) below.
#[test]
fn apply_effects_start_quest_no_op_when_already_done() {
    let mut state = state_with_done_quest("q1"); // q1 is done
    apply_effects(&[DialogueEffect::StartQuest("q1".to_string())], &mut state);
    assert!(
        !state.active_quests.contains("q1"),
        "StartQuest on a completed quest must be a no-op: \
         q1 must NOT be re-added to active_quests"
    );
    assert!(
        state.done_quests.contains("q1"),
        "done_quests must be unchanged after StartQuest on a completed quest"
    );
}

// ---------------------------------------------------------------------------
// CRITERION: Determinism
// ---------------------------------------------------------------------------

// Test 26 — Same tree + state → same available_choices output
/// kills: any impl that reads global mutable state (clock, thread-local RNG,
///        HashMap with non-deterministic iteration order exposed as indices).
#[test]
fn dialogue_evaluation_deterministic() {
    let node = simple_node(
        "n1",
        "Choose.",
        vec![
            unconditional_choice("Option A"),
            DialogueChoice {
                text: "Option B".to_string(),
                conditions: vec![Condition::HasFlag("unlocked".to_string())],
                effects: vec![],
                next_node: None,
            },
            unconditional_choice("Option C"),
        ],
    );

    let state = state_with_flag("unlocked");

    let r1 = available_choices(&node, &state);
    let r2 = available_choices(&node, &state);
    assert_eq!(
        r1, r2,
        "available_choices must be deterministic: same node + state must always return same indices"
    );
    // Also assert correctness: indices 0, 1, 2 all available
    assert_eq!(r1, vec![0, 1, 2], "all three choices must be available");
}
