//! Pure quest advance rules (ADR-0068).
//!
//! All functions are stateless, deterministic, and free of side effects.

use crate::dialogue::{evaluate_condition, PlayerDialogueState};
use crate::quest::model::{PlayerQuestProgress, QuestAdvance, QuestDef, StepTrigger, TriggerEvent};

/// Check whether a player can start the given quest.
///
/// Returns `true` only if ALL of the following hold:
/// 1. The quest is NOT already in the active `progress` slice.
/// 2. The quest is NOT in `dialogue_state.done_quests`.
/// 3. All `def.start_conditions` pass against `dialogue_state`.
#[must_use]
pub fn can_start_quest(
    def: &QuestDef,
    dialogue_state: &PlayerDialogueState,
    progress: &[PlayerQuestProgress],
) -> bool {
    // Guard: already active
    if progress.iter().any(|p| p.quest_id == def.id) {
        return false;
    }
    // Guard: already done
    if dialogue_state.done_quests.contains(&def.id) {
        return false;
    }
    // All start conditions must pass
    def.start_conditions
        .iter()
        .all(|c| evaluate_condition(c, dialogue_state))
}

/// Check if a `StepTrigger` is satisfied by a `TriggerEvent`.
///
/// - `Talk`: exact `npc_id` match.
/// - `Collect`: exact `item_id` match AND `event.qty >= trigger.qty` (at-least).
/// - `Defeat`: exact `species_id` match.
/// - Mismatched variant types → `false`.
#[must_use]
pub fn trigger_matches(trigger: &StepTrigger, event: &TriggerEvent) -> bool {
    match (trigger, event) {
        (StepTrigger::Talk { npc_id: t }, TriggerEvent::Talked { npc_id: e }) => t == e,
        (
            StepTrigger::Collect {
                item_id: ti,
                qty: tq,
            },
            TriggerEvent::Collected {
                item_id: ei,
                qty: eq,
            },
        ) => ti == ei && eq >= tq,
        (StepTrigger::Defeat { species_id: t }, TriggerEvent::Defeated { species_id: e }) => t == e,
        _ => false,
    }
}

/// Try to advance a quest's progress given an event.
///
/// # Contracts
/// 1. **Bounds-check**: if `progress.step_index >= def.steps.len()` → `None`
///    (already done or invalid state — safe no-op).
/// 2. `trigger_matches(current_step.trigger, event)` must be `true`.
/// 3. ALL `current_step.conditions` must pass (evaluated here, not only at
///    `can_start_quest`).
/// 4. If all pass:
///    - Last step → `QuestAdvance::QuestComplete { reward: def.reward.clone() }`
///    - Otherwise → `QuestAdvance::StepComplete { new_step: step_index + 1 }`
///
/// Note: the return value must be used — a reducer that drops it silently skips the advance.
/// (`Option` is already `#[must_use]`; no attribute needed here.)
pub fn process_trigger(
    def: &QuestDef,
    progress: &PlayerQuestProgress,
    dialogue_state: &PlayerDialogueState,
    event: &TriggerEvent,
) -> Option<QuestAdvance> {
    // Contract 1: bounds-check (safe cast; on 16-bit targets u32 may exceed usize::MAX → None)
    let idx = usize::try_from(progress.step_index).ok()?;
    if idx >= def.steps.len() {
        return None;
    }

    let step = &def.steps[idx];

    // Contract 2: trigger must match
    if !trigger_matches(&step.trigger, event) {
        return None;
    }

    // Contract 3: step-level conditions must all pass
    if !step
        .conditions
        .iter()
        .all(|c| evaluate_condition(c, dialogue_state))
    {
        return None;
    }

    // Contract 4: advance or complete
    let is_last = idx == def.steps.len() - 1;
    if is_last {
        Some(QuestAdvance::QuestComplete {
            reward: def.reward.clone(),
        })
    } else {
        Some(QuestAdvance::StepComplete {
            new_step: progress.step_index + 1,
        })
    }
}
