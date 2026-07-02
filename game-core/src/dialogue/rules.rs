//! Pure dialogue evaluation rules (ADR-0068).
//!
//! All functions are stateless, deterministic, and free of side effects.
//! The server reducer owns the actual table mutations; these functions
//! compute *what* should happen given the current state.

use serde::{Deserialize, Serialize};

use crate::dialogue::model::{
    Condition, DialogueChoice, DialogueEffect, DialogueNode, DialogueTree, PlayerDialogueState,
};

// ---------------------------------------------------------------------------
// Public error / result types
// ---------------------------------------------------------------------------

/// Errors returned by `apply_choice`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DialogueError {
    /// `choice_idx` is out of bounds for `node.choices`.
    InvalidChoice,
    /// The choice exists but its conditions are not met.
    ChoiceUnavailable,
}

/// The result of a successful `apply_choice` call.
#[derive(Debug)]
pub struct ChoiceResult<'a> {
    /// All effects from the selected choice (including server-side `GrantXp` /
    /// `GrantItem` — the server extracts these; `apply_effects` no-ops them).
    pub effects: &'a [DialogueEffect],
    /// Next dialogue node id, or `None` to end the dialogue.
    pub next_node_id: Option<&'a str>,
}

// ---------------------------------------------------------------------------
// Public rule functions
// ---------------------------------------------------------------------------

/// Evaluate a single condition against player state.
///
/// This is the SSOT for condition evaluation — every caller uses this function.
#[must_use]
pub fn evaluate_condition(cond: &Condition, state: &PlayerDialogueState) -> bool {
    match cond {
        Condition::HasFlag(f) => state.flags.contains(f),
        Condition::NotFlag(f) => !state.flags.contains(f),
        Condition::QuestActive(q) => state.active_quests.contains(q),
        Condition::QuestDone(q) => state.done_quests.contains(q),
    }
}

/// Find the first entry node whose `entry_conditions` all pass.
///
/// Returns `None` when all nodes have at least one unmet condition.
#[must_use]
pub fn find_entry_node<'a>(
    tree: &'a DialogueTree,
    state: &PlayerDialogueState,
) -> Option<&'a DialogueNode> {
    tree.nodes.iter().find(|node| {
        node.entry_conditions
            .iter()
            .all(|c| evaluate_condition(c, state))
    })
}

/// Return the indices of choices in `node.choices` whose conditions all pass.
///
/// Preserves declaration order. An empty `conditions` list always passes
/// (vacuous truth).
#[must_use]
pub fn available_choices(node: &DialogueNode, state: &PlayerDialogueState) -> Vec<usize> {
    node.choices
        .iter()
        .enumerate()
        .filter_map(|(i, choice)| {
            let all_pass = choice
                .conditions
                .iter()
                .all(|c| evaluate_condition(c, state));
            if all_pass {
                Some(i)
            } else {
                None
            }
        })
        .collect()
}

/// Apply a player's choice and return the resulting effects + next node.
///
/// # Security contract
/// This function checks availability **internally** — it does NOT trust the
/// caller to pre-filter via `available_choices`. This makes it safe to call
/// directly from M12b reducers without a separate pre-check.
///
/// Proof-of-teeth: an impl that skips the condition check here would allow a
/// player to bypass flag gates by sending a raw choice index.
///
/// # Errors
/// - `DialogueError::InvalidChoice` — `choice_idx >= node.choices.len()`
/// - `DialogueError::ChoiceUnavailable` — choice exists but conditions unmet
pub fn apply_choice<'a>(
    node: &'a DialogueNode,
    choice_idx: usize,
    state: &PlayerDialogueState,
) -> Result<ChoiceResult<'a>, DialogueError> {
    if choice_idx >= node.choices.len() {
        return Err(DialogueError::InvalidChoice);
    }
    let choice: &'a DialogueChoice = &node.choices[choice_idx];

    // Re-check conditions internally — do NOT trust the caller
    if !choice
        .conditions
        .iter()
        .all(|c| evaluate_condition(c, state))
    {
        return Err(DialogueError::ChoiceUnavailable);
    }

    Ok(ChoiceResult {
        effects: &choice.effects,
        next_node_id: choice.next_node.as_deref(),
    })
}

/// Apply a slice of dialogue effects to mutable player state.
///
/// Uses an exhaustive `match` so that any new `DialogueEffect` variant added
/// in the future forces a deliberate decision at every call site.
///
/// `GrantXp` and `GrantItem` are explicit no-ops here — they are server-side
/// only. The server retrieves them from `ChoiceResult.effects` and routes them
/// through the M9 inventory/XP helpers.
pub fn apply_effects(effects: &[DialogueEffect], state: &mut PlayerDialogueState) {
    for effect in effects {
        match effect {
            DialogueEffect::SetFlag(f) => {
                state.flags.insert(f.clone());
            }
            DialogueEffect::ClearFlag(f) => {
                state.flags.remove(f);
            }
            DialogueEffect::StartQuest(q) => {
                // Idempotency guard: don't re-open a completed quest
                if !state.done_quests.contains(q) {
                    state.active_quests.insert(q.clone());
                }
            }
            DialogueEffect::GrantXp(_) => {} // server-side only; caller extracts from ChoiceResult
            DialogueEffect::GrantItem(_, _) => {} // server-side only; caller extracts from ChoiceResult
        }
    }
}

/// Apply the entry auto-effects of a dialogue node to player state.
///
/// M12b **must** call this immediately after `find_entry_node` returns `Some(node)`,
/// before displaying choices. Omitting this call silently discards all `auto_effects`
/// (flags set on node entry, quests started on approach, etc.).
///
/// Quest completion (moving a quest from `active_quests` → `done_quests`) is the
/// server reducer's (M12b's) responsibility — this function does not do it.
pub fn apply_node_auto_effects(node: &DialogueNode, state: &mut PlayerDialogueState) {
    apply_effects(&node.auto_effects, state);
}
